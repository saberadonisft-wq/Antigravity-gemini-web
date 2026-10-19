import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { GeminiDomFixtureServer } from "./fixture-server.js";
import { LiveGeminiBrowserAdapter } from "./index.js";
import { removeFixtureProfile } from "./fixture-cleanup.js";

test("Real CDP snapshot upload reads exact UTF-8, waits for processing, validates the chip again at Send and cancels before Send", {timeout:40000}, async t => {
  const fixture = new GeminiDomFixtureServer({signedIn:true,streamDelayMs:2}); await fixture.start();
  const port = await new Promise<number>(resolve => { const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{const value=(server.address() as net.AddressInfo).port;server.close(()=>resolve(value));}); });
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-driver-test-profile-"));
  const browser = new LiveGeminiBrowserAdapter({targetUrl:fixture.url,allowedOrigins:[fixture.url],fixtureMode:true,headless:true,userDataDir:directory,debugPort:port});
  t.after(async()=>{await browser.cleanup();await fixture.stop();await removeFixtureProfile(directory);});
  assert.equal((await browser.openBrowser()).opened,true);
  const content="START_Việt_😀\n"+"Synthetic reference text. ".repeat(4000)+"\nEND_đúng_😀";
  const sha256=createHash("sha256").update(content).digest("hex"), snapshot={version:1 as const,mediaType:"text/plain" as const,fileName:`ag-native-context-${sha256}.txt`,sha256,content};
  const expectedAccountFingerprint=createHash("sha256").update("testuser@example.com").digest("hex");
  await assert.rejects(browser.submitPrompt("no-lease","controller",{snapshotAttachment:snapshot,expectedAccountFingerprint}),{code:"SNAPSHOT_REQUIRES_LEASE",delivery:"not_sent"});
  for (const mode of ["ready","changed","cancel","error","identity"] as const) {
    const lease=await browser.openFreshConversation();
    let snapshotPath="";const originalUpload=browser.driver.uploadSnapshot.bind(browser.driver);
    browser.driver.uploadSnapshot=async(...args)=>{const file=await originalUpload(...args);snapshotPath=file.file;return file;};
    await browser.driver.cdp!.evaluate(`(() => {
      const button=document.createElement('button');button.setAttribute('aria-label','Upload & tools');button.textContent='Upload';document.body.appendChild(button);
      button.onclick=()=>{const overlay=document.createElement('div');overlay.className='cdk-overlay-pane';overlay.innerHTML='<images-files-uploader><input type="file" accept=".txt"></images-files-uploader>';document.body.appendChild(overlay);
        overlay.querySelector('input').onchange=async event=>{const file=event.target.files[0];window.deferredSnapshot=file;window.snapshotSize=file.size;${mode === "identity" ? "document.querySelector('[data-test-id=user-avatar]').setAttribute('aria-label','Google Account: other@example.com');" : ""}
          const tooltip=document.createElement('div');tooltip.id='snapshot-tooltip';tooltip.setAttribute('role','tooltip');tooltip.style.display='none';tooltip.textContent=file.name;document.body.appendChild(tooltip);
          const chip=document.createElement('uploader-file-preview');chip.style.display='block';chip.innerHTML='<div aria-describedby="snapshot-tooltip" style="width:120px;height:30px">Attachment</div><mat-spinner></mat-spinner>';document.body.appendChild(chip);
          setTimeout(()=>{chip.querySelector('mat-spinner').remove();${mode === "error" ? "chip.innerHTML+='<span class=\"error-icon\"></span>';" : ""}},250);
        };};
      document.querySelector('#sendBtn').addEventListener('click',async()=>{try{window.snapshotBytes=await window.deferredSnapshot.text();}catch(error){window.snapshotReadError=error.name;}document.querySelectorAll('uploader-file-preview').forEach(e=>e.remove());},{capture:true});
    })()`);
    const originalInput=browser.driver.inputPrompt.bind(browser.driver);
    browser.driver.inputPrompt=async(text,check)=>{
      if(mode==="changed") await browser.driver.cdp!.evaluate("document.querySelector('uploader-file-preview').remove()");
      if(mode==="cancel") void browser.cancelPrompt("snapshot-"+mode);
      return originalInput(text,check);
    };
    try {
      const submission=browser.submitPrompt("snapshot-"+mode,"Read the attached context.",{snapshotAttachment:snapshot,expectedAccountFingerprint});
      if(mode==="ready") { assert.equal((await submission).status,"accepted");assert.ok(fs.existsSync(snapshotPath));assert.equal((await browser.pollResponse("snapshot-"+mode,{deadlineMs:5000})).status,"completed");assert.ok(!fs.existsSync(snapshotPath)); }
      else await assert.rejects(submission,(error:{code:string;delivery:string})=>error.delivery==="not_sent"&&["UNEXPECTED_ATTACHMENT","CANCELLED","SNAPSHOT_UPLOAD_FAILED","ACCOUNT_IDENTITY_CHANGED"].includes(error.code));
      if(mode==="ready"){assert.equal(await browser.driver.cdp!.evaluate("window.snapshotReadError"),undefined);assert.equal(await browser.driver.cdp!.evaluate("window.snapshotBytes"),content);}
      else assert.equal(await browser.driver.cdp!.evaluate("window.snapshotSize"),Buffer.byteLength(content));
      assert.equal(await browser.driver.cdp!.evaluate("document.querySelectorAll('.user-query').length"),mode==="ready"?1:0);
    } finally {browser.driver.inputPrompt=originalInput;browser.driver.uploadSnapshot=originalUpload;await lease.close();if(snapshotPath)assert.ok(!fs.existsSync(snapshotPath));}
  }
});


test("Snapshot files survive uncertain/pending browser outcomes and are removed only after terminal confirmation or owned-target close",{timeout:30000},async t=>{
  const fixture=new GeminiDomFixtureServer({signedIn:true,streamDelayMs:250});await fixture.start();
  const port=await new Promise<number>(resolve=>{const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const value=(server.address() as net.AddressInfo).port;server.close(()=>resolve(value));});});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-driver-test-profile-"));
  const browser=new LiveGeminiBrowserAdapter({targetUrl:fixture.url,allowedOrigins:[fixture.url],fixtureMode:true,headless:true,userDataDir:directory,debugPort:port});
  t.after(async()=>{await browser.cleanup();await fixture.stop();await removeFixtureProfile(directory);});assert.equal((await browser.openBrowser()).opened,true);
  const content="Retained synthetic file Việt 😀",sha256=createHash("sha256").update(content).digest("hex"),snapshot={version:1 as const,mediaType:"text/plain" as const,fileName:`ag-native-context-${sha256}.txt`,sha256,content},expectedAccountFingerprint=createHash("sha256").update("testuser@example.com").digest("hex");
  for(const mode of ["timeout","cancel","unknown_click"] as const){
    const lease=await browser.openFreshConversation();let file="";
    const upload=browser.driver.uploadSnapshot.bind(browser.driver),click=browser.driver.clickSend.bind(browser.driver);
    browser.driver.uploadSnapshot=async(...args)=>{const result=await upload(...args);file=result.file;return result;};
    await browser.driver.cdp!.evaluate(`(()=>{const button=document.createElement('button');button.setAttribute('aria-label','Upload & tools');button.textContent='Upload';document.body.appendChild(button);button.onclick=()=>{const overlay=document.createElement('div');overlay.className='cdk-overlay-pane';overlay.innerHTML='<images-files-uploader><input type="file" accept=".txt"></images-files-uploader>';document.body.appendChild(overlay);overlay.querySelector('input').onchange=event=>{const chip=document.createElement('uploader-file-preview');chip.style.display='block';chip.innerHTML='<div style="height:30px;width:750px"></div>';chip.firstChild.textContent=event.target.files[0].name;document.body.appendChild(chip);};};})()`);
    if(mode==="unknown_click")browser.driver.clickSend=async(_check,_expected,onClick)=>{onClick?.();throw {code:"OUTCOME_UNKNOWN",message:"Synthetic lost acknowledgement",retryable:false};};
    try{
      const id="lifetime-"+mode,submission=browser.submitPrompt(id,"Synthetic lifecycle request",{snapshotAttachment:snapshot,expectedAccountFingerprint});
      if(mode==="unknown_click"){await assert.rejects(submission,{code:"OUTCOME_UNKNOWN",delivery:"unknown"});assert.ok(fs.existsSync(file));}
      else{
        assert.equal((await submission).status,"accepted");assert.ok(fs.existsSync(file));
        if(mode==="timeout"){assert.equal((await browser.pollResponse(id,{deadlineMs:30})).status,"failed");assert.ok(fs.existsSync(file));}
        else{assert.equal((await browser.cancelPrompt(id)).cancelled,true);assert.ok(!fs.existsSync(file));}
      }
    }finally{browser.driver.uploadSnapshot=upload;browser.driver.clickSend=click;await lease.close();if(file)assert.ok(!fs.existsSync(file));}
  }
});
