import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { WebSocket } from "ws";
import { startExtensionConnector } from "./extension-connector.js";
import { CdpClient, configureExtensionCdp } from "./cdp-client.js";
import { GeminiBrowserDriver } from "./gemini-browser-driver.js";
import { verifyBrowserProfile } from "./profile-identity.js";

const credentials = () => ({ version: 1 as const, profileId: randomUUID(), token: randomBytes(32).toString("hex") });
async function fakeProfile(t: TestContext, label: string) {
  const auth = credentials(), broker = await startExtensionConnector(auth, 0);
  t.after(async () => { configureExtensionCdp(); await broker.close(); });
  const calls: string[] = [];
  const attach = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${broker.port}/extension`, { origin: "chrome-extension://" + "a".repeat(32) });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "extension", ...auth })));
      ws.on("message", data => {
        const request = JSON.parse(data.toString());
        if (request.type === "ready") { resolve(); return; }
        calls.push(request.method);
        if (request.method === "Runtime.evaluate" && request.params.expression === "hold") return;
        const result = request.method === "Connector.listTargets" ? [
          { targetId: "tab_1", url: "https://gemini.google.com/app/fixture" },
          { targetId: "tab_2", url: "https://accounts.google.com/" },
        ] : { result: { value: label } };
        ws.send(JSON.stringify({ id: request.id, result }));
      });
    });
    t.after(() => ws.terminate()); return ws;
  };
  return { auth, broker, calls, attach };
}
test("Connector requires exact loopback authority, authenticated workers and an extension origin", async t => {
  const f = await fakeProfile(t, "A"), base = `http://127.0.0.1:${f.broker.port}`;
  assert.equal((await fetch(base + "/json/list")).status, 403);
  assert.equal((await fetch(base + "/json/list", { headers: { authorization: "Bearer " + f.auth.token, origin: "https://example.com" } })).status, 403);
  const wrongHost = await new Promise<number|undefined>((resolve,reject)=>{const request=http.get(base+"/json/list",{headers:{authorization:"Bearer "+f.auth.token,host:"evil.invalid"}},response=>{response.resume();resolve(response.statusCode);});request.on("error",reject);});
  assert.equal(wrongHost, 403);
  await assert.rejects(new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${f.broker.port}/extension`, { origin: "https://example.com" }); ws.once("error", reject); ws.once("open", () => {ws.terminate(); resolve(undefined);}); }));
  const wrong = new WebSocket(`ws://127.0.0.1:${f.broker.port}/page/tab_1`);
  await new Promise<void>(resolve => { wrong.on("open", () => wrong.send(JSON.stringify({type:"auth",role:"worker",profileId:f.auth.profileId,token:"é".repeat(64)}))); wrong.once("close", () => resolve()); });
  assert.equal(f.broker.connected, false); assert.deepEqual(f.calls, []);
});
test("Each profile routes to its own account and rejects duplicate pairing or unsupported browser commands", async t => {
  const a = await fakeProfile(t, "ACCOUNT_A"), b = await fakeProfile(t, "ACCOUNT_B");
  await a.attach(); await b.attach();
  configureExtensionCdp({ port: a.broker.port, ...a.auth });
  const targetA = await CdpClient.findTarget(a.broker.port); assert.equal(targetA?.id, "tab_1");
  const pageA = new CdpClient(targetA!.webSocketDebuggerUrl!); await pageA.connect(); t.after(() => pageA.close());
  assert.equal(await pageA.evaluate("marker"), "ACCOUNT_A");
  assert.equal(await verifyBrowserProfile(pageA, "unused", a.broker.port, "unused", a.auth.profileId), true);
  assert.equal(await verifyBrowserProfile(pageA, "unused", a.broker.port, "unused", b.auth.profileId), false);
  await assert.rejects(pageA.send("Browser.close"));
  await assert.rejects(pageA.send("Target.createTarget", {url:"https://accounts.google.com/"}));
  await assert.rejects(pageA.send("DOM.setFileInputFiles", {files:["private.txt"]}));
  const list = await pageA.send<{targetInfos:any[]}>("Target.getTargets"); assert.equal(list.targetInfos.length, 1);
  const duplicate = new WebSocket(`ws://127.0.0.1:${a.broker.port}/extension`, {origin:"chrome-extension://"+"a".repeat(32)});
  await new Promise<void>(resolve => {duplicate.on("open",()=>duplicate.send(JSON.stringify({type:"auth",role:"extension",...a.auth})));duplicate.once("close",()=>resolve());});
  assert.equal(await pageA.evaluate("marker"), "ACCOUNT_A");
  configureExtensionCdp({ port: b.broker.port, ...b.auth });
  const targetB = await CdpClient.findTarget(b.broker.port), pageB = new CdpClient(targetB!.webSocketDebuggerUrl!);
  await pageB.connect(); t.after(() => pageB.close()); assert.equal(await pageB.evaluate("marker"), "ACCOUNT_B");
  assert.equal(await pageA.evaluate("marker"), "ACCOUNT_A");
});
test("A disconnected profile rejects in-flight commands and never replays them after reconnection", async t => {
  const f = await fakeProfile(t, "A"), extension = await f.attach();
  configureExtensionCdp({port:f.broker.port,...f.auth});
  const target = await CdpClient.findTarget(f.broker.port), client = new CdpClient(target!.webSocketDebuggerUrl!); await client.connect(); t.after(()=>client.close());
  const pending = assert.rejects(client.evaluate("hold"));
  while(!f.calls.includes("Runtime.evaluate")) await new Promise(resolve=>setTimeout(resolve,5));
  extension.close(); await pending;
  while(f.broker.connected) await new Promise(resolve=>setTimeout(resolve,5));
  const count = f.calls.filter(name=>name==="Runtime.evaluate").length;
  await f.attach(); assert.equal(f.calls.filter(name=>name==="Runtime.evaluate").length,count);
});
test("An offline extension never launches a replacement Chrome process", async t => {
  const f = await fakeProfile(t, "A"); configureExtensionCdp({port:f.broker.port,...f.auth});
  const driver = new GeminiBrowserDriver({debugPort:f.broker.port,connectorProfileId:f.auth.profileId,requireProfileIdentity:true,chromePath:"must-not-launch.exe"});
  assert.equal(await driver.launchOrAttach(100),false); assert.equal(driver.isOwnedProcess,false); assert.equal(driver.isProcessAlive,false); await driver.close();
});

test("Connector status is authenticated and reports a real connection without creating a tab",async t=>{
 const f=await fakeProfile(t,"status");await f.attach();
 const url=`http://127.0.0.1:${f.broker.port}/connector/status`;
 assert.equal((await fetch(url)).status,403);
 const response=await fetch(url,{headers:{authorization:"Bearer "+f.auth.token}});const status=await response.json() as any;
 assert.equal(status.connected,true);assert.ok(Number.isInteger(status.geminiTabs));assert.ok(!JSON.stringify(status).includes(f.auth.token));
 assert.ok(!f.calls.includes("Target.createTarget"));
});
