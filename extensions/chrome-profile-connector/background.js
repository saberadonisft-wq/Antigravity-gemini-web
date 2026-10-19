let socket, heartbeat, configuration, ready = false, epoch = 0;
const attached = new Set(), attaching = new Map(), owned = new Set();
const allowed = value => {
  try { const url = new URL(value); return url.origin === 'https://gemini.google.com' && !url.username && !url.password; } catch { return false; }
};
function check(connection, captured) {
  if (socket !== connection || epoch !== captured || connection.readyState !== WebSocket.OPEN) throw Error('Connection changed. No command was retried.');
}
async function attach(tabId, connection, captured) {
  if (!attached.has(tabId)) {
    if (attached.size + attaching.size >= 256) throw Error('Debugger target limit reached.');
    let pending = attaching.get(tabId);
    if (!pending) {
      pending = chrome.debugger.attach({ tabId }, '1.3').then(async () => {
        if (socket !== connection || epoch !== captured) { await chrome.debugger.detach({tabId}).catch(() => {}); throw Error('Connection changed.'); }
        attached.add(tabId);
      }).finally(() => attaching.delete(tabId));
      attaching.set(tabId, pending);
    }
    await pending;
  }
  check(connection, captured);
}
async function execute(message, connection, captured) {
  check(connection, captured);
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('Invalid command.');
  if (message.method === 'Connector.listTargets') {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    check(connection, captured);
    return tabs.filter(tab => !tab.incognito && allowed(tab.url)).map(tab => ({ targetId: 'tab_' + tab.id, url: tab.url }));
  }
  if (message.method === 'Target.createTarget') {
    if (!allowed(params.url)) throw Error('Only Gemini pages are supported.');
    if (owned.size >= 128) throw Error('Owned tab limit reached. Close unused connector tabs first.');
    const tab = await chrome.tabs.create({ url: params.url, active: false });
    owned.add(tab.id);
    check(connection, captured);
    return { targetId: 'tab_' + tab.id };
  }
  if (message.method === 'Target.closeTarget') {
    if (!/^tab_[0-9]+$/.test(params.targetId)) throw Error('Invalid target.');
    const tabId = Number(params.targetId.slice(4));
    if (!owned.has(tabId)) throw Error('Existing user tabs are preserved.');
    const tab = await chrome.tabs.get(tabId);
    check(connection, captured);
    if (!allowed(tab.url)) throw Error('Target changed.');
    await chrome.tabs.remove(tabId); owned.delete(tabId);
    return { success: true };
  }
  if (!/^tab_[0-9]+$/.test(message.targetId)) throw Error('Invalid page target.');
  const tabId = Number(message.targetId.slice(4)), tab = await chrome.tabs.get(tabId);
  check(connection, captured);
  if (tab.incognito || !allowed(tab.url)) throw Error('Authentication and other websites are not supported.');
  const permitted = new Set(['Runtime.evaluate', 'Input.insertText', 'Input.dispatchMouseEvent', 'Emulation.setFocusEmulationEnabled']);
  if (!permitted.has(message.method)) throw Error('Unsupported operation.');
  let normalized;
  if (message.method === 'Runtime.evaluate') {
    if (typeof params.expression !== 'string' || params.expression.length > 1000000) throw Error('Invalid expression.');
    normalized = { expression: `if(location.origin!=='https://gemini.google.com')throw Error('Target changed');\n${params.expression}`, returnByValue: true, awaitPromise: true };
  } else if (message.method === 'Input.insertText') {
    if (typeof params.text !== 'string' || params.text.length > 1000000) throw Error('Invalid input.');
    normalized = { text: params.text };
  } else if (message.method === 'Input.dispatchMouseEvent') {
    if (!['mousePressed', 'mouseReleased'].includes(params.type) || !Number.isFinite(params.x) || !Number.isFinite(params.y) || params.x < 0 || params.y < 0 || params.button !== 'left' || params.clickCount !== 1) throw Error('Invalid click.');
    normalized = { type: params.type, x: params.x, y: params.y, button: 'left', clickCount: 1 };
  } else {
    if (typeof params.enabled !== 'boolean') throw Error('Invalid focus state.');
    normalized = { enabled: params.enabled };
  }
  await attach(tabId, connection, captured);
  const latest = await chrome.tabs.get(tabId);
  check(connection, captured);
  if (!allowed(latest.url)) throw Error('Target changed.');
  return await chrome.debugger.sendCommand({ tabId }, message.method, normalized) ?? {};
}
async function disconnect() {
  ++epoch; ready = false; clearInterval(heartbeat);
  const previous = socket; socket = undefined; previous?.close();
  await Promise.allSettled([...attached].map(tabId => chrome.debugger.detach({ tabId })));
  attached.clear();
}
async function connect() {
  await disconnect();
  if (!configuration) throw Error('Paste a pairing code first.');
  const connection = new WebSocket(`ws://127.0.0.1:${configuration.port}/extension`), captured = epoch;
  socket = connection;
  connection.onopen = () => { if (socket === connection) connection.send(JSON.stringify({ type: 'auth', role: 'extension', profileId: configuration.profileId, token: configuration.token })); };
  connection.onmessage = async event => {
    if (socket !== connection || epoch !== captured) return;
    let message;
    try { message = JSON.parse(event.data); } catch { connection.close(); return; }
    if (message.type === 'ready') {
      if (message.profileId !== configuration.profileId) { connection.close(); return; }
      ready = true;
      await chrome.action.setBadgeText({ text: 'ON' });
      heartbeat = setInterval(() => { if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'ping' })); }, 20000);
      return;
    }
    if (message.type === 'pong') return;
    if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') { connection.close(); return; }
    try {
      const result = await execute(message, connection, captured);
      check(connection, captured); connection.send(JSON.stringify({ id: message.id, result }));
    } catch { if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, error: 'Operation unavailable or refused; no retry.' })); }
  };
  connection.onclose = () => { if (socket === connection) { void disconnect(); void chrome.action.setBadgeText({ text: 'OFF' }); } };
  connection.onerror = () => { connection.close(); };
}
function parsePairing(code) {
  if (typeof code !== 'string' || !code.startsWith('agc1.') || code.length > 2048) throw Error('Mã ghép nối không hợp lệ.');
  const bytes = Uint8Array.from(atob(code.slice(5).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9-]{36}$/.test(value.profileId) || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128) throw Error('Mã ghép nối không hợp lệ.');
  return { version: 1, port: value.port, profileId: value.profileId, token: value.token, name: value.name };
}
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  configuration = (await chrome.storage.local.get('configuration')).configuration;
  await chrome.action.setBadgeText({ text: 'OFF' });
}
const initialized = initialize().then(() => true, () => false);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return;
  (async () => {
    if (!(await initialized)) return { ok: false, error: 'Extension chưa khởi tạo được. Tải lại extension tại chrome://extensions.' };
    if (message.action === 'pair') {
      if (socket?.readyState === WebSocket.OPEN) throw Error('Ngắt kết nối trước khi ghép lại.');
      const next = parsePairing(message.code);
      if (configuration?.profileId !== next.profileId) owned.clear();
      configuration = next; await chrome.storage.local.set({ configuration });
    } else if (message.action === 'connect') await connect();
    else if (message.action === 'disconnect') await disconnect();
    else if (message.action !== 'status') throw Error('Yêu cầu không hợp lệ.');
    return { name: configuration?.name, connected: ready && socket?.readyState === WebSocket.OPEN };
  })().then(result => respond(result?.ok === false ? result : { ok: true, ...result }), () => respond({ ok: false, error: 'Không thể thực hiện. Kiểm tra mã ghép nối và Native owner.' }));
  return true;
});
chrome.debugger.onDetach.addListener(({ tabId }, reason) => { attached.delete(tabId); if (socket && reason === 'canceled_by_user') void disconnect(); });
chrome.tabs.onRemoved.addListener(tabId => { owned.delete(tabId); attached.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (attached.has(tabId) && change.url && !allowed(change.url)) void disconnect(); });
