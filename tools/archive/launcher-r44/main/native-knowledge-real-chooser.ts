import type { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { KnowledgeSnapshotSchema } from "@antigravity-gemini-web/contracts";

/** Observe a real OS chooser run; no renderer clicks, input or chooser stubbing. */
export async function runNativeKnowledgeRealChooser(window:BrowserWindow,directory:string){
  const owner=JSON.parse(fs.readFileSync(path.join(directory,"native-owner.json"),"utf8"));
  const endpoint=new URL(owner.endpoint);assert.equal(endpoint.hostname,"127.0.0.1");assert.equal(endpoint.protocol,"http:");
  const read=async()=>KnowledgeSnapshotSchema.parse(await fetch(endpoint.origin+"/__native/knowledge",{method:"POST",headers:{"x-native-control-token":owner.controlToken,"content-type":"application/json"},body:JSON.stringify({action:"status"}),signal:AbortSignal.timeout(3000)}).then(response=>{assert.ok(response.ok);return response.json();}));
  const deadline=performance.now()+900000,eventsFile=path.join(directory,"knowledge-real-chooser-events.jsonl");
  while(performance.now()<deadline){
    const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
    const selection=events.findIndex(event=>event.type==="selected"),cancelAfterSelection=events.findIndex((event,index)=>event.type==="cancel"&&index>selection);
    if(selection>=0&&cancelAfterSelection>selection){
      const snapshot=await read(),source=snapshot.sources.find(item=>item.kind==="local_folder");
      if(!source){await new Promise(resolve=>setTimeout(resolve,100));continue;}
      assert.equal(events.filter(event=>event.type==="selected").length,1);assert.equal(events[selection]!.count,2);assert.ok(events.every((event,index)=>index%2===0?event.type==="open":["selected","cancel"].includes(event.type)));
      assert.equal(snapshot.sources.length,2);assert.equal(snapshot.bindings.length,0);assert.equal(source.fileCount,2);assert.deepEqual(source.selectedFiles,["README.md","architecture.md"]);assert.ok(!JSON.stringify(snapshot).includes(directory));assert.ok(!JSON.stringify(snapshot).includes("SYNTHETIC_KNOWLEDGE_DESKTOP_CONTENT"));
      // Observe completion of the existing real IPC handler, without injecting input.
      const feedback=await window.webContents.executeJavaScript("document.querySelector('.native-account-feedback')?.textContent??''");
      if(!String(feedback).includes("Đã hủy chọn file")&&!String(feedback).includes("File selection cancelled")){await new Promise(resolve=>setTimeout(resolve,100));continue;}
      await new Promise(resolve=>setTimeout(resolve,500));assert.equal((await read()).sources.length,2);
      const picture=await window.webContents.capturePage();assert.equal(picture.isEmpty(),false);fs.writeFileSync(path.join(directory,"knowledge-real-chooser.png"),picture.toPNG());
      const health=await fetch(endpoint.origin+"/__native/health",{signal:AbortSignal.timeout(3000)}).then(response=>response.json());
      fs.writeFileSync(path.join(directory,"native-knowledge-real-chooser.json"),JSON.stringify({checkedAt:new Date().toISOString(),status:"PASS_REAL_WINDOWS_CHOOSER_SELECTED_AND_CANCEL",nativeRuntimeRevision:health.runtimeRevision,electron:"REAL",ipc:"REAL_SANDBOXED_PRELOAD",owner:"REAL_HTTP",osChooser:"REAL_WINDOWS_OPEN_FILE_DIALOG",interaction:"COMPUTER_USE_SKY",browser:"SYNTHETIC",realIdeExecutor:"NOT_TESTED",selectedFiles:source.selectedFiles,selectedFileCount:2,sourceCountAfterCancel:2,bindingsCreated:0,importPathsFromRenderer:false,rootOrContentInRendererSnapshot:false,noDuplicateImportAfterCancel:true,chooserEventTypes:events.map(event=>event.type)},null,2)+"\n");return;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("Real chooser acceptance deadline; no completion claimed");
}
