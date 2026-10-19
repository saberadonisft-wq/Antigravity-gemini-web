// Isolated clock-offset reproduction only; not elapsed-time/soak acceptance.
import fs from "node:fs";
import path from "node:path";
import { GeminiMcpService } from "../../packages/mcp-server/dist/service.js";
const root=fs.mkdtempSync(path.join(process.cwd(),".tmp/cache-expiry-spike-"));let sends=0;
const browser={checkStatus:async()=>({browserState:"ready",accountState:"signed_in",checkedAt:new Date().toISOString()}),openBrowser:async()=>({opened:true}),submitPrompt:async turnId=>{sends++;return {turnId,status:"accepted",submittedAt:new Date().toISOString()};},pollResponse:async turnId=>({turnId,status:"completed",text:"SYNTHETIC_CACHE_RESULT",completedAt:new Date().toISOString()}),cancelPrompt:async turnId=>({turnId,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");}};
const service=new GeminiMcpService(browser,path.join(root,"receipts.json")),originalNow=Date.now;
let evidence;
try{
  await service.submit("expiry_spike_fixture","synthetic only");await service.result("expiry_spike_fixture",1000);
  const settled=originalNow();Date.now=()=>settled+600001;
  const inspected=await service.inspectReceipt("expiry_spike_fixture");
  let resultStatus;try{resultStatus=(await service.result("expiry_spike_fixture")).status;}catch(error){resultStatus=error.code;}
  evidence={checkedAt:new Date(originalNow()).toISOString(),kind:"SYNTHETIC_ISOLATED_CLOCK_OFFSET",offsetMs:600001,receiptRetained:inspected.found,resultAvailable:inspected.resultAvailable,resultStatus,syntheticSends:sends,realGoogleRequests:0,status:!inspected.resultAvailable&&resultStatus==="OUTCOME_UNKNOWN"?"PASS_EXPIRED_READ_FENCE":"REPRODUCED_EXPIRED_RESULT_STILL_READABLE"};
}finally{Date.now=originalNow;await service.close();}
const output=process.argv.find(value=>value.startsWith("--output="))?.slice(9)??path.join(root,"evidence.json");
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
