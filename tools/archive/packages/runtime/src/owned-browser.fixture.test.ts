import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { GeminiDomFixtureServer } from "@antigravity-gemini-web/gemini-browser/testing";
import { OwnedBrowserAdapter } from "./owned-browser.js";

type OwnedProcessIdentity = { pid: number; startedAt: string };
async function observeOwnedWindowsProcesses(profile: string, identities: OwnedProcessIdentity[] = [], rootPid?: number, timeoutMs = 5000): Promise<OwnedProcessIdentity[]> {
  if (process.platform !== "win32") return [];
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
    $taskIdentities = @(ConvertFrom-Json $env:AG_FIXTURE_PROCESS_IDENTITIES)
    $taskOwned = @{}
    foreach ($taskProcess in $taskProcesses) {
      $taskStarted = $taskProcess.CreationDate.ToUniversalTime().Ticks.ToString()
      $taskTracked = @($taskIdentities | Where-Object { $_.pid -eq $taskProcess.ProcessId -and $_.startedAt -eq $taskStarted }).Count -gt 0
      if ($taskProcess.ProcessId -eq [int]$env:AG_FIXTURE_ROOT_PID -or $taskTracked -or ($taskProcess.CommandLine -and $taskProcess.CommandLine.Contains($env:AG_FIXTURE_PROFILE))) { $taskOwned[[int]$taskProcess.ProcessId] = $taskProcess }
    }
    do {
      $taskAdded = $false
      foreach ($taskProcess in $taskProcesses) {
        if (-not $taskOwned.ContainsKey([int]$taskProcess.ProcessId) -and $taskOwned.ContainsKey([int]$taskProcess.ParentProcessId)) { $taskOwned[[int]$taskProcess.ProcessId] = $taskProcess; $taskAdded = $true }
      }
    } while ($taskAdded)
    $taskResult = @($taskOwned.Values | ForEach-Object { @{pid=[int]$_.ProcessId;startedAt=$_.CreationDate.ToUniversalTime().Ticks.ToString()} })
    ConvertTo-Json -InputObject $taskResult -Compress
  `;
  const pwsh = path.join(process.env.ProgramFiles!, "PowerShell/7/pwsh.exe");
  const shell = await fs.access(pwsh).then(() => pwsh, () => path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"));
  const result = await promisify(execFile)(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: timeoutMs,
    env: { ...process.env, AG_FIXTURE_PROFILE: profile, AG_FIXTURE_ROOT_PID: String(rootPid ?? 0), AG_FIXTURE_PROCESS_IDENTITIES: JSON.stringify(identities) },
  });
  return JSON.parse(result.stdout.trim()) as OwnedProcessIdentity[];
}
async function assertNoOwnedWindowsProcesses(profile: string, identities: OwnedProcessIdentity[]): Promise<void> {
  const deadline = performance.now() + 10000;
  let remaining = await observeOwnedWindowsProcesses(profile, identities, undefined, Math.max(1, Math.floor(Math.min(5000, deadline - performance.now()))));
  while (remaining.length > 0 && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - performance.now())));
    if (performance.now() >= deadline) break;
    remaining = await observeOwnedWindowsProcesses(profile, identities, undefined, Math.max(1, Math.floor(Math.min(5000, deadline - performance.now()))));
  }
  assert.deepEqual(remaining, [], "Owned Chrome processes must actually exit, including captured descendants; cleanup failures are not ignored");
}

test("G4 acceptance: owned Chrome fixture opens, activates its page, crashes and reconnects without replay", { timeout: 45000 }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "g4-owned-browser-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 2 });
  let browser: OwnedBrowserAdapter | undefined;
  const ownedProcesses: OwnedProcessIdentity[] = [];
  t.after(async () => {
    try { await browser?.cleanup(); } finally {
      try { await assertNoOwnedWindowsProcesses(profile, ownedProcesses); } finally { await fixture.stop(); }
      assert.equal(path.dirname(await fs.realpath(profile)).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(profile).startsWith("g4-owned-browser-"));
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  await fixture.start();
  const probe = net.createServer();
  const port = await new Promise<number>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const p = (probe.address() as net.AddressInfo).port; probe.close(error => error ? reject(error) : resolve(p)); }); });
  browser = new OwnedBrowserAdapter({ fixtureMode: true, allowedOrigins: [new URL(fixture.url).origin], targetUrl: fixture.url, userDataDir: profile, debugPort: port, headless: true });
  assert.equal((await browser.openBrowser()).opened, true);
  assert.equal(browser.driver.isOwnedProcess, true);
  assert.equal(browser.driver.isAttachedTarget, false);
  assert.equal((await browser.checkStatus()).accountState, "signed_in");
  await browser.driver.cdp!.send("Runtime.evaluate", { expression: "window.__ownedFixture = 'first-process'" });
  assert.equal((await browser.openBrowser()).opened, true);
  const marker = await browser.driver.cdp!.evaluate<string>("window.__ownedFixture");
  assert.equal(marker, "first-process", "Focus must keep the same owned target");
  await browser.submitPrompt("owned-before-crash", "Fixture-only prompt");
  assert.equal((await browser.pollResponse("owned-before-crash", { deadlineMs: 5000 })).status, "completed");
  const processInfo = (browser.driver as unknown as { childProcess: ChildProcess }).childProcess;
  assert.ok(Number.isSafeInteger(processInfo.pid));
  ownedProcesses.push(...await observeOwnedWindowsProcesses(profile, [], processInfo.pid));
  // Kill the exact spawned root, rather than racing taskkill's changing tree snapshot.
  // A successful kill request is insufficient: wait for the real exit and CDP loss.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Owned Chrome root did not exit within the crash budget")); }, 5000);
    const cleanup = () => { clearTimeout(timer); processInfo.off("exit", exited); processInfo.off("error", failed); };
    const exited = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    processInfo.once("exit", exited); processInfo.once("error", failed);
    if (processInfo.exitCode !== null || processInfo.signalCode !== null) { cleanup(); reject(Error("Owned Chrome root exited before the crash action.")); return; }
    try {
      if (process.platform === "win32") void promisify(execFile)("taskkill", ["/F", "/PID", String(processInfo.pid)], { windowsHide: true, timeout: 3000 }).catch(failed);
      else assert.equal(processInfo.kill("SIGKILL"), true, "Intentional crash must terminate the exact owned root");
    }
    catch (error) { cleanup(); reject(error); }
  });
  assert.ok(processInfo.exitCode !== null || processInfo.signalCode !== null, "Crash must produce an observed process exit");
  const deadline = Date.now() + 5000;
  while (browser.driver.isConnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(browser.driver.isConnected, false);
  await assertNoOwnedWindowsProcesses(profile, ownedProcesses);
  assert.equal((await browser.checkStatus()).accountState, "unknown");
  assert.equal((await browser.openBrowser()).opened, true);
  const reconnected = (browser.driver as unknown as { childProcess: ChildProcess }).childProcess;
  assert.notEqual(reconnected.pid, processInfo.pid, "Reconnect must spawn a new owned Chrome root");
  ownedProcesses.push(...await observeOwnedWindowsProcesses(profile, [], reconnected.pid));
  assert.equal(await browser.driver.cdp!.evaluate("window.__ownedFixture || null"), null, "New process must not revive the old page");
  assert.equal(await browser.driver.cdp!.evaluate<number>("document.querySelectorAll('.user-query').length"), 0, "Reconnect must not resend a previous prompt");
  await browser.submitPrompt("owned-after-crash", "New explicit fixture prompt");
  assert.equal((await browser.pollResponse("owned-after-crash", { deadlineMs: 5000 })).status, "completed");
});
