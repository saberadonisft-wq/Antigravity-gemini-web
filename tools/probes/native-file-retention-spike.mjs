// Local Chromium File API experiment. No Gemini Web or real account is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { GeminiDomFixtureServer,LiveGeminiBrowserAdapter } from "../../packages/gemini-browser/dist/index.js";
import { removeFixtureProfile } from "../../packages/gemini-browser/dist/fixture-cleanup.js";

const fixture=new GeminiDomFixtureServer({signedIn:true,streamDelayMs:2});await fixture.start();
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-driver-test-profile-")),browser=new LiveGeminiBrowserAdapter({targetUrl:fixture.url,allowedOrigins:[fixture.url],fixtureMode:true,headless:true,userDataDir:profile,debugPort:port});
const content="FILE_BEGIN_Việt_😀\n"+"Synthetic attachment data. ".repeat(3200)+"\nFILE_END_đúng_😀",sha256=createHash("sha256").update(content).digest("hex"),fileName=`ag-native-context-${sha256}.txt`;
const evidence={checkedAt:new Date().toISOString(),surface:"local_Chromium_fixture",browserRequestsToGoogle:0,contentChars:content.length,utf8Bytes:Buffer.byteLength(content),contentSha256:sha256,cases:[]};
try{
  assert.equal((await browser.openBrowser()).opened,true);
  for(const retainUntilRead of [false,true]){
    const lease=await browser.openFreshConversation(),directory=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-native-file-spike-")),file=path.join(directory,fileName);
    fs.writeFileSync(file,content,{flag:"wx",mode:0o600});
    try{
      await browser.driver.cdp.evaluate(`(()=>{
        const input=document.createElement('input');input.type='file';input.accept='.txt';input.id='lifetime-fixture-input';document.body.appendChild(input);
        input.onchange=()=>{window.deferredFile=input.files[0];const chip=document.createElement('uploader-file-preview');chip.style.display='block';chip.innerHTML='<div style="height:30px;width:750px"></div>';chip.firstChild.textContent=window.deferredFile.name;document.body.appendChild(chip);window.fileChosen=true;};
        document.querySelector('#sendBtn').addEventListener('click',async()=>{try{window.lateFileRead={text:await window.deferredFile.text()};}catch(error){window.lateFileRead={error:error.name};}},{capture:true});
      })()`);
      const root=await browser.driver.cdp.send("DOM.getDocument",{depth:0}),nodes=await browser.driver.cdp.send("DOM.querySelectorAll",{nodeId:root.root.nodeId,selector:'#lifetime-fixture-input'});assert.equal(nodes.nodeIds.length,1);
      await browser.driver.cdp.send("DOM.setFileInputFiles",{files:[file],nodeId:nodes.nodeIds[0]});
      const selectedUntil=performance.now()+3000;while(!await browser.driver.cdp.evaluate("window.fileChosen===true")){assert.ok(performance.now()<selectedUntil);await new Promise(resolve=>setTimeout(resolve,20));}
      let earlyDeleteSucceeded=false;
      if(!retainUntilRead){try{fs.unlinkSync(file);earlyDeleteSucceeded=true;}catch{}}
      const existedAtSend=fs.existsSync(file);assert.equal(await browser.driver.inputPrompt("Read the selected synthetic attachment."),true);
      assert.equal(await browser.driver.clickSend(()=>{},createHash("sha256").update("testuser@example.com").digest("hex"),undefined,fileName),true);
      let result;const readUntil=performance.now()+5000;while(!(result=await browser.driver.cdp.evaluate("window.lateFileRead"))){assert.ok(performance.now()<readUntil);await new Promise(resolve=>setTimeout(resolve,20));}
      const exactRead=typeof result.text==="string"&&result.text===content;
      evidence.cases.push({retainUntilRead,earlyDeleteSucceeded,existedAtSend,exactRead,...(result.error?{readError:result.error}:{})});
      if(retainUntilRead)assert.ok(exactRead,"Retained-file control must preserve exact Unicode bytes.");
    }finally{await lease.close();fs.rmSync(file,{force:true});fs.rmdirSync(directory);}
  }
}finally{await browser.cleanup();await fixture.stop();await removeFixtureProfile(profile);}
evidence.demonstratesLateReadFailureAfterDeletion=evidence.cases[0].earlyDeleteSucceeded&&!evidence.cases[0].exactRead&&evidence.cases[1].exactRead;
evidence.status=evidence.demonstratesLateReadFailureAfterDeletion?"REPRODUCED_LOCAL_FILE_LIFETIME_FAILURE":"HYPOTHESIS_NOT_REPRODUCED";
evidence.boundary="Chromium File API behavior only. Whether Gemini re-reads the local file after chip readiness requires a separate live test.";
fs.writeFileSync("docs/evidence/mcp/native-file-retention-local-spike.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
