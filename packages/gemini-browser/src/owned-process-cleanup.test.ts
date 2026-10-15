import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { GeminiBrowserDriver } from "./gemini-browser-driver.js";

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("Windows owned cleanup terminates a real grandchild before its root can become untraceable", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n'));setInterval(()=>{},1000);"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let descendant: number | undefined;
  t.after(() => {
    for (const pid of [child.pid, descendant]) if (pid && alive(pid)) {
      try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore", timeout: 3000 }); } catch {}
    }
  });
  descendant = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned child did not become ready.")), 3000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.once("data", bytes => { clearTimeout(timer); const pid = Number(String(bytes).trim()); if (Number.isSafeInteger(pid) && pid > 0) resolve(pid); else reject(Error("Invalid child identity.")); });
  });
  assert.ok(child.pid && alive(child.pid)); assert.ok(alive(descendant));
  const driver = new GeminiBrowserDriver();
  (driver as unknown as { childProcess: ChildProcess }).childProcess = child;
  driver.isOwnedProcess = true;
  await driver.close();
  const deadline = performance.now() + 1500;
  while (alive(descendant) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(alive(descendant), false, "The owned descendant must not survive its root.");
});
