import { createHash } from "node:crypto";
import { ChatImportSurfaceObservationSchema, type ChatImportSurfaceObservation } from "@antigravity-gemini-web/contracts";
import { CdpClient } from "./cdp-client.js";
import { assertBrowserAccountIdentity, type GeminiBrowserDriver } from "./gemini-browser-driver.js";
import { GEMINI_SELECTORS, isAllowedSurfaceUrl } from "./gemini-selectors.js";
import { verifyBrowserProfile } from "./profile-identity.js";

// Fixed read-only DOM inspection. No whole-page text, chat content, file input writes or clicks.
const inspection = `(() => {
  const visible = el => !!el && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = el => (el?.innerText || el?.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  const headings = [...document.querySelectorAll('h1,[role=heading][aria-level="1"]')].filter(visible);
  const titles = headings.filter(el => /^(import memory to gemini|nhập bộ nhớ vào gemini)$/i.test(label(el)));
  const sections = [...document.querySelectorAll('h2,[role=heading][aria-level="2"]')].filter(visible).filter(el => /^(import chats|nhập cuộc trò chuyện|nhập các cuộc trò chuyện)$/i.test(label(el)));
  const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible);
  const upload = buttons.filter(el => /^(add|thêm)$/i.test(label(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const memory = buttons.filter(el => /^(add memory|thêm bộ nhớ)$/i.test(label(el)));
  const inputs = [...document.querySelectorAll('textarea')].filter(visible);
  const avatar = document.querySelector(${JSON.stringify(GEMINI_SELECTORS.ACCOUNT_AVATAR)});
  const identity = visible(avatar) && (avatar.getAttribute('aria-label') || avatar.getAttribute('title') || avatar.getAttribute('alt') || '');
  const chatSurface = !!document.querySelector('rich-textarea,model-response,.model-response,[data-test-id="model-response"]');
  return { url: location.href, importPage: document.readyState === 'complete' && titles.length === 1 && !chatSurface,
    ambiguous: titles.length > 1 || sections.length > 1 || upload.length > 1 || memory.length > 1 || inputs.length > 1,
    chat: sections.length === 1 && upload.length === 1, memory: inputs.length === 1 && memory.length === 1,
    identity: typeof identity === 'string' ? identity.slice(0, 512) : '' };
})()`;

export function emptyImportObservation(status: ChatImportSurfaceObservation["status"]): ChatImportSurfaceObservation {
  return { status, observedAt: new Date().toISOString(), identityVerified: false, chatUploadControlObserved: false, memoryControlsObserved: false, evidence: "visible_controls_only", googleSubmission: "not_submitted" };
}

/** Inspect existing non-conversation tabs only. Never open/navigate/activate/close a user tab. */
export async function inspectExistingImportSurface(driver: GeminiBrowserDriver, expectedFingerprint: string, check: () => void): Promise<ChatImportSurfaceObservation> {
  check();
  if (driver.connectorProfileId) return emptyImportObservation("not_observed");
  const deadline = performance.now() + 10000;
  const bounded = () => { check(); if (performance.now() >= deadline) throw Error("Import inspection deadline."); };
  let bootstrap: CdpClient | undefined;
  try {
    let original = driver.cdp?.isConnected ? driver.cdp : undefined;
    if (!original) {
      const target = await CdpClient.findTarget(driver.debugPort, candidate => candidate.type === "page" && allowed(driver, candidate.url));
      if (!target?.webSocketDebuggerUrl) return emptyImportObservation("browser_unavailable");
      bootstrap = new CdpClient(target.webSocketDebuggerUrl); await bootstrap.connect(1500); original = bootstrap;
    }
    // Fixture mode already owns an isolated, synthetic browser and an explicit
    // allowlisted origin; production inspection still requires OS/CDP profile proof.
    if (!driver.fixtureMode && !await verifyBrowserProfile(original, driver.userDataDir, driver.debugPort, driver.chromePath)) return emptyImportObservation("browser_unavailable");
    bounded(); return await scan(driver, original, expectedFingerprint, bounded);
  } catch { check(); return emptyImportObservation("browser_unavailable"); }
  finally { bootstrap?.close(); }
}
function allowed(driver: GeminiBrowserDriver, value: string) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (driver.fixtureMode ? isAllowedSurfaceUrl(value, { fixtureMode: true, allowedOrigins: driver.allowedOrigins }) : url.origin === "https://gemini.google.com") && !/^\/app\/[a-f0-9]{12,64}\/?$/.test(url.pathname);
  } catch { return false; }
}
async function scan(driver: GeminiBrowserDriver, original: CdpClient, expectedFingerprint: string, check: () => void): Promise<ChatImportSurfaceObservation> {
  const list = () => original.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets", {}, 2500);
  const targets = (await list()).targetInfos.filter(target => target.type === "page" && allowed(driver, target.url));
  if (targets.length > 8) return emptyImportObservation("ambiguous");
  const found: ChatImportSurfaceObservation[] = [];
  for (const target of targets) {
    check(); let page: CdpClient | undefined;
    try {
      const endpoint = await CdpClient.findTarget(driver.debugPort, candidate => candidate.id === target.targetId && candidate.url === target.url);
      if (!endpoint?.webSocketDebuggerUrl) continue;
      page = new CdpClient(endpoint.webSocketDebuggerUrl); await page.connect(1500);
      const observed = await page.evaluate<{ url: string; importPage: boolean; ambiguous: boolean; chat: boolean; memory: boolean; identity: string }>(inspection, true, 1500);
      check(); if (!observed?.importPage || observed.url !== target.url) continue;
      const current = (await list()).targetInfos.find(value => value.targetId === target.targetId);
      if (current?.url !== target.url) return emptyImportObservation("ambiguous");
      if (observed.ambiguous) return emptyImportObservation("ambiguous");
      try { assertBrowserAccountIdentity(observed.identity, expectedFingerprint); }
      catch (error) { return emptyImportObservation(error && typeof error === "object" && "code" in error && error.code === "ACCOUNT_IDENTITY_CHANGED" ? "identity_changed" : "identity_unverified"); }
      if (observed.chat || observed.memory) found.push(ChatImportSurfaceObservationSchema.parse({ ...emptyImportObservation("controls_observed"), identityVerified: true,
        surfaceId: createHash("sha256").update(JSON.stringify([target.targetId, endpoint.webSocketDebuggerUrl, target.url])).digest("hex"), chatUploadControlObserved: observed.chat, memoryControlsObserved: observed.memory }));
    } catch { check(); return emptyImportObservation("browser_unavailable"); }
    finally { page?.close(); }
  }
  check(); return found.length > 1 ? emptyImportObservation("ambiguous") : found[0] ?? emptyImportObservation("not_observed");
}
