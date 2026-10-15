import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveGeminiBrowserAdapter, CdpClient } from "../../packages/gemini-browser/dist/index.js";
import { acquireOwnership } from "../../packages/mcp-server/dist/ownership.js";

// Inspect the app-owned account surface. Never change language, activity, location or permissions.
const adapter = new LiveGeminiBrowserAdapter({ userDataDir: path.join(os.homedir(), ".gemini/antigravity-gemini-web-live/app_data/browser_profile"), debugPort: 9223 });
const report = { observedAt: new Date().toISOString(), customApps: "NOT_TESTED", cleanup: false };
let browser, page, targetId, owner;
const watchdog = setTimeout(() => { console.error("Custom apps probe deadline"); void adapter.cleanup().finally(() => process.exit(124)); }, 25000);
try {
  owner = await acquireOwnership(`browser:${path.resolve(adapter.driver.userDataDir)}`);
  if (!(await adapter.openBrowser()).opened) throw Error("BROWSER_UNAVAILABLE");
  const version = await (await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(2000) })).json();
  browser = new CdpClient(version.webSocketDebuggerUrl); await browser.connect();
  targetId = (await browser.send("Target.createTarget", { url: "https://gemini.google.com/apps", background: true })).targetId;
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const target = await CdpClient.findTarget(9223, t => t.id === targetId);
    if (target?.webSocketDebuggerUrl) { page = new CdpClient(target.webSocketDebuggerUrl); await page.connect(); break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!page) throw Error("TARGET_NOT_READY");
  let surface;
  do {
    surface = await page.evaluate(`(() => {
      const text = document.body?.innerText || '';
      return {
        exactOrigin: location.origin === 'https://gemini.google.com',
        path: location.pathname,
        ready: document.readyState === 'complete' && text.length > 300,
        customSection: /custom apps|ứng dụng tuỳ chỉnh|ứng dụng tùy chỉnh/i.test(text),
        mcpField: [...document.querySelectorAll('input')].some(e => /mcp|add a custom app/i.test((e.getAttribute('placeholder')||'') + (e.getAttribute('aria-label')||''))),
        addCustomControl: [...document.querySelectorAll('button,a')].some(e => /add a custom app|thêm ứng dụng tuỳ chỉnh|thêm ứng dụng tùy chỉnh/i.test(e.innerText||e.getAttribute('aria-label')||'')),
        googleAppsObserved: /Google Workspace|YouTube|Google Maps|Google Keep/i.test(text),
        language: document.documentElement.lang
      };
    })()`);
    if (surface?.exactOrigin && surface.ready && surface.googleAppsObserved) break;
    await new Promise(r => setTimeout(r, 400));
  } while (performance.now() < deadline);
  report.surface = surface;
  report.customApps = surface?.exactOrigin && ["/apps", "/customize/connectors"].includes(surface.path) && (surface.mcpField || surface.addCustomControl) ? "SETUP_CONTROL_OBSERVED" : "NOT_OBSERVED";
} catch { report.customApps = "PROBE_FAILED"; process.exitCode = 1; }
finally {
  page?.close();
  if (browser && targetId) { try { await browser.send("Target.closeTarget", { targetId }); } catch {} }
  browser?.close();
  try { await adapter.cleanup(); report.cleanup = true; } catch { process.exitCode = 1; }
  owner?.close();
  clearTimeout(watchdog);
  fs.mkdirSync("docs/evidence/mcp", { recursive: true });
  fs.writeFileSync("docs/evidence/mcp/custom-apps.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
