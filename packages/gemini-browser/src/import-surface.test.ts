import test from "node:test";
import { openFixtureBrowser } from "./fixture-server.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { LiveGeminiBrowserAdapter, CdpClient, GeminiDomFixtureServer } from "./index.js";
import { removeFixtureProfile } from "./fixture-cleanup.js";

test("Real CDP import observation preserves tabs/drafts and rejects hidden, duplicate, wrong-account and chat controls", {timeout:45000}, async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-driver-test-profile-")),fixture=new GeminiDomFixtureServer({signedIn:true});
  const port=await new Promise<number>(resolve=>{const socket=net.createServer();socket.listen(0,"127.0.0.1",()=>{const port=(socket.address() as net.AddressInfo).port;socket.close(()=>resolve(port));});});
  let live:LiveGeminiBrowserAdapter|undefined;const pages:{id:string;page:CdpClient}[]=[];
  t.after(async()=>{try{for(const {id,page} of pages){page.close();await CdpClient.closeOwnedTarget(port,id).catch(()=>{});}await live?.cleanup();}finally{await fixture.stop();await removeFixtureProfile(directory);}});
  await fixture.start();live=new LiveGeminiBrowserAdapter({targetUrl:fixture.url,userDataDir:directory,debugPort:port,headless:true,fixtureMode:true,allowedOrigins:[new URL(fixture.url).origin]});
  const opened=await openFixtureBrowser(live);assert.equal(opened.opened,true,opened.actionReason);const original=live.driver.cdp!,originalWs=original.wsUrl;
  const composerReady=await live.driver.waitForComposerReady(),composerProbe=await original.evaluate(`(()=>{const editor=document.querySelector("rich-textarea div[contenteditable='true'], rich-textarea textarea"),rect=editor?.getBoundingClientRect(),style=editor&&getComputedStyle(editor);return {url:location.href,readyState:document.readyState,hasEditor:!!editor,height:rect?.height,disabled:editor?.disabled,readOnly:editor?.readOnly,ariaBusy:!!editor?.closest('[aria-busy="true"]'),inert:!!editor?.closest('[inert]'),pointerEvents:style?.pointerEvents,hasAccount:!!document.querySelector('[data-test-id="user-avatar"]'),stopVisible:[...document.querySelectorAll('button.stop-button')].some(node=>node.getBoundingClientRect().height>0)}})()`);assert.equal(composerReady,true,JSON.stringify({status:await live.checkStatus(),composerProbe}));assert.equal(await live.driver.inputPrompt("PRESERVE_IMPORT_PROBE_DRAFT"),true);
  assert.equal(await original.evaluate("document.querySelector('[contenteditable=true]').textContent"),"PRESERVE_IMPORT_PROBE_DRAFT");
  const fingerprint=createHash("sha256").update("fixture@example.test").digest("hex");
  assert.equal((await live.inspectImportSurface(fingerprint)).status,"not_observed");
  const html='<h1>Import memory to Gemini</h1><textarea placeholder="Paste your info here..."></textarea><button disabled>Add memory</button><h2>Import chats</h2><button id="upload">Add</button><span data-test-id="user-avatar" aria-label="Google Account: Fixture (fixture@example.test)">F</span>';
  const open=async()=>{
    const {targetId}=await original.send<{targetId:string}>("Target.createTarget",{url:fixture.url,background:true});
    const deadline=performance.now()+5000;let page:CdpClient|undefined;
    while(!page){assert.ok(performance.now()<deadline);const target=await CdpClient.findTarget(port,target=>target.id===targetId);if(target?.webSocketDebuggerUrl){page=new CdpClient(target.webSocketDebuggerUrl);await page.connect();}else await new Promise(resolve=>setTimeout(resolve,20));}
    pages.push({id:targetId,page});while(await page.evaluate("document.readyState !== 'complete'")){assert.ok(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20));}
    await page.evaluate(`history.replaceState({},'', '/settings/import-fixture');document.body.innerHTML=${JSON.stringify(html)}`);return page;
  };
  const page=await open();const observed=await live.inspectImportSurface(fingerprint);assert.equal(observed.status,"controls_observed");assert.equal(observed.chatUploadControlObserved,true);assert.equal(observed.memoryControlsObserved,true);assert.equal(observed.googleSubmission,"not_submitted");assert.ok(!JSON.stringify(observed).includes("example.test"));
  await page.evaluate("document.querySelector('#upload').hidden=true");assert.equal((await live.inspectImportSurface(fingerprint)).chatUploadControlObserved,false);
  await page.evaluate("document.querySelector('#upload').hidden=false;document.body.insertAdjacentHTML('beforeend','<button id=duplicate>Add</button>')");assert.equal((await live.inspectImportSurface(fingerprint)).status,"ambiguous");await page.evaluate("document.querySelector('#duplicate').remove()");
  await page.evaluate("document.querySelector('[data-test-id=user-avatar]').setAttribute('aria-label','Google Account: Other (other@example.test)')");assert.equal((await live.inspectImportSurface(fingerprint)).status,"identity_changed");
  await page.evaluate(`document.body.innerHTML=${JSON.stringify(html)};document.querySelector('[data-test-id=user-avatar]').remove()`);assert.equal((await live.inspectImportSurface(fingerprint)).status,"identity_unverified");
  await page.evaluate(`document.body.innerHTML=${JSON.stringify(html)};document.body.insertAdjacentHTML('beforeend','<model-response>Import memory to Gemini</model-response>')`);assert.equal((await live.inspectImportSurface(fingerprint)).status,"not_observed");
  await page.evaluate(`document.body.innerHTML=${JSON.stringify(html)}`);await open();assert.equal((await live.inspectImportSurface(fingerprint)).status,"ambiguous");
  assert.equal(live.driver.cdp!.wsUrl,originalWs);assert.equal(await original.evaluate("document.querySelector('[contenteditable=true]').textContent"),"PRESERVE_IMPORT_PROBE_DRAFT");assert.equal(fixture.turnsReceived.length,0);
});
