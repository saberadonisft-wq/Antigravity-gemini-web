import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiBrowserDriver } from "./gemini-browser-driver.js";
import { LiveGeminiBrowserAdapter } from "./index.js";
import { CdpCommandTimeoutError } from "./cdp-client.js";
import type { DomInspectionResult } from "./gemini-selectors.js";

const ready: DomInspectionResult = {
  url:"http://127.0.0.1/app",origin:"http://127.0.0.1",pathname:"/app",title:"Fixture",
  isAllowedSurface:true,accountState:"signed_in",accountIdentity:"fixture@example.invalid",
  hasComposer:true,hasSendButton:true,isGenerating:false,responseCount:1,
  lastResponseText:"partial",hasCodeBlock:false,hasResponseCompletion:false
};

test("A read at the polling deadline returns incomplete; an early transport timeout still fails",async()=>{
  const driver=new GeminiBrowserDriver();
  driver.inspectDom=async budget=>{await new Promise(resolve=>setTimeout(resolve,(budget??0)+10));throw new CdpCommandTimeoutError("Runtime.evaluate",budget??0);};
  assert.deepEqual(await driver.pollForResponse(0,20),{text:"",completed:false,cancelled:false,hasCodeBlock:false});
  driver.inspectDom=async()=>{throw new CdpCommandTimeoutError("Runtime.evaluate",1);};
  await assert.rejects(driver.pollForResponse(0,1000),CdpCommandTimeoutError);
  const controller=new AbortController();
  driver.inspectDom=async()=>{controller.abort(Error("cancelled fixture"));return {...ready,hasResponseCompletion:true};};
  await assert.rejects(driver.pollForResponse(0,1000,{signal:controller.signal}),/cancelled fixture/);
});

test("Read-only observations recover from navigation context loss but never retry other CDP errors",async()=>{
  const driver=new GeminiBrowserDriver();let reads=0;
  Object.assign(driver,{cdp:{evaluate:async()=>{if(++reads===1)throw Error("CDP Error -32000: Execution context was destroyed.");return ready;}}});
  assert.deepEqual(await driver.inspectDom(1000),ready);assert.equal(reads,2);
  Object.assign(driver,{cdp:{evaluate:async()=>{reads++;throw Error("CDP Error: target closed");}}});
  await assert.rejects(driver.inspectDom(1000),/target closed/);assert.equal(reads,3);
});

test("Account readiness waits for identity hydration even when the composer mounted first",async()=>{
  const adapter=new LiveGeminiBrowserAdapter({fixtureMode:true});let reads=0;
  Object.assign(adapter.driver,{cdp:{isConnected:true}});
  adapter.driver.inspectDom=async()=>++reads<3?{...ready,accountState:"unknown",accountIdentity:undefined}:ready;
  const status=await adapter.checkStatus();
  assert.equal(status.browserState,"ready");assert.equal(status.accountIdentity,"fixture@example.invalid");assert.equal(reads,3);
});
