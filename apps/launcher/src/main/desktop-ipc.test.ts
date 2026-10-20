import {test} from "node:test";
import assert from "node:assert/strict";
import {DesktopIpc} from "./desktop-ipc.js";
import {nativeAccountFixture} from "../testing/native-account-fixture.js";

test("Desktop IPC isolates the owner and pairing secret behind the registered main frame",async()=>{
  const snapshot=nativeAccountFixture();let reads=0,copies=0;const pairing="agc1.privateabcdefghijklmnop";
  const bridge=new DesktopIpc({getNativeAccounts:async()=>{reads++;return snapshot;},executeNativeAccount:async()=>snapshot,createNativeExtensionPairingCode:async()=>pairing},id=>id===7,code=>{assert.equal(code,pairing);copies++;});
  const context={sender:{id:7},isMainFrame:true,origin:"app://local/index.html"};
  for(const other of [{...context,isMainFrame:false},{...context,origin:"https://evil.invalid"},{...context,sender:{id:8}}])assert.equal((await bridge.invoke("launcher:getNativeAccounts",other)).ok,false);
  assert.equal(reads,0);assert.equal((await bridge.invoke("launcher:getSnapshot",context)).ok,false);
  assert.equal((await bridge.invoke("launcher:getNativeAccounts",context,-1)).ok,false);
  const result=await bridge.invoke("launcher:copyNativeExtensionPairingCode",context,{accountId:snapshot.accounts[0].accountId,expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision});
  assert.equal(result.ok,true);assert.equal(copies,1);assert.ok(!JSON.stringify(result).includes(pairing));
});
