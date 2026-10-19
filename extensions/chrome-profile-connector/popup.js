const status = document.querySelector('#status'), buttons = [...document.querySelectorAll('button')];
async function run(action, extra = {}) {
  buttons.forEach(button => button.disabled = true);
  try {
    const result = await chrome.runtime.sendMessage({ action, ...extra });
    status.textContent = result?.ok ? `${result.name ?? 'Chưa ghép nối'} — ${result.connected ? 'Đã mở kết nối; xác minh Gemini trong launcher' : 'Chưa kết nối'}` : result?.error ?? 'Không thể kết nối.';
  } catch { status.textContent = 'Extension chưa sẵn sàng. Mở lại bảng này.'; }
  finally { buttons.forEach(button => button.disabled = false); }
}
document.querySelector('#pair').addEventListener('click', async () => { const input = document.querySelector('#pairing'); const code = input.value.trim(); input.value = ''; await run('pair', { code }); });
document.querySelector('#connect').addEventListener('click', () => run('connect'));
document.querySelector('#disconnect').addEventListener('click', () => run('disconnect'));
await run('status');
