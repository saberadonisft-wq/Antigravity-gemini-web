import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { LiveGeminiBrowserAdapter } from "./index.js";
import { GeminiDomFixtureServer, openFixtureBrowser } from "./fixture-server.js";
import { removeFixtureProfile } from "./fixture-cleanup.js";

test("Fresh native conversation owns a new tab and restores the original page and unsent draft", { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  const port = await new Promise<number>(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); });
  });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => {
    try { await live?.cleanup(); } finally { await fixture.stop(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("gemini-driver-test-profile-")); await removeFixtureProfile(directory); }
  });
  await fixture.start();
  // Fixture origin is only known after binding its ephemeral port.
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  assert.equal((await openFixtureBrowser(live)).opened, true);
  for (let retry = 0; retry < 20 && (await live.checkStatus()).browserState !== "ready"; retry++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await live.driver.inputPrompt("ORIGINAL_UNSENT_DRAFT"), true);
  const original = live.driver.cdp!.wsUrl;
  const lease = await live.openFreshConversation();
  assert.notEqual(live.driver.cdp!.wsUrl, original);
  assert.equal((await live.driver.inspectDom()).responseCount, 0);
  assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[contenteditable=true]').textContent"), "");
  await lease.close();
  assert.equal(live.driver.cdp!.wsUrl, original);
  assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[contenteditable=true]').textContent"), "ORIGINAL_UNSENT_DRAFT");
  const targets = await live.driver.cdp!.send<{ targetInfos: Array<{ type: string }> }>("Target.getTargets");
  assert.equal(targets.targetInfos.filter(target => target.type === "page").length, 1);
});
