import { LiveGeminiBrowserAdapter } from "../../../packages/gemini-browser/dist/index.js";

// Status-only probe; no prompts, raw CDP target URLs or conversation titles.
async function main() {
  const adapter = new LiveGeminiBrowserAdapter({
    userDataDir: "C:\\Users\\vhc\\.gemini\\gemini_web_probe_profile", debugPort: 9222, headless: true,
  });
  const result = { observedAt: new Date().toISOString(), opened: false, cleanup_successful: false };
  const watchdog = setTimeout(async () => {
    try { await adapter.cleanup(); } catch {}
    console.error(JSON.stringify({ errorCode: "PROBE_TIMEOUT", cleanupVerified: false }));
    process.exit(124);
  }, 15000);
  try {
    result.opened = (await adapter.openBrowser()).opened;
    if (!result.opened) throw new Error("OPEN_FAILED");
    const status = await adapter.checkStatus();
    const dom = await adapter.driver.inspectDom(2000);
    let origin;
    try { origin = new URL(dom.url).origin; } catch {}
    Object.assign(result, {
      browserState: status.browserState, accountState: status.accountState, errorCode: status.error?.code,
      origin: origin === "https://gemini.google.com" ? origin : "unrecognized",
      isAllowedSurface: dom.isAllowedSurface, hasComposer: dom.hasComposer,
      ownership: adapter.driver.isOwnedProcess ? "owned_process" : "attached_target",
    });
  } catch {
    result.errorCode = "PROBE_FAILED";
    process.exitCode = 1;
  } finally {
    try { await adapter.cleanup(); result.cleanup_successful = true; }
    catch { result.errorCode = "CLEANUP_FAILED"; process.exitCode = 1; }
    clearTimeout(watchdog);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(() => { console.error(JSON.stringify({ errorCode: "PROBE_FAILED" })); process.exitCode = 1; });
