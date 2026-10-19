import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { extensionCredentials } from "@antigravity-gemini-web/gemini-browser";
import { McpNativeBrowserBackend } from "./browser-backend.js";
import { sha256 } from "./native-protocol.js";

test("An extension account uses the real MCP worker and rejects an identity change before input",{timeout:30000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ag-extension-worker-")),profile=path.join(directory,"profile"),state=path.join(directory,"state");
  const auth=extensionCredentials(profile),cli=fileURLToPath(new URL("../../mcp-server/dist/cli.js",import.meta.url));
  const port=await new Promise<number>(resolve=>{const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const value=(server.address() as net.AddressInfo).port;server.close(()=>resolve(value));});});
  const backend=new McpNativeBrowserBackend(cli,{AG_MCP_BROWSER_PROFILE:profile,AG_MCP_STATE_DIR:state,AG_MCP_DEBUG_PORT:String(port),AG_MCP_BROWSER_TRANSPORT:"extension",AG_MCP_NODE_SEMI_SPACE_MB:"off"},sha256("a@fixture.invalid"));
  let connection:WebSocket|undefined,identity="a@fixture.invalid";const commands:string[]=[];
  t.after(async()=>{
    await backend.close();connection?.terminate();
    const descriptor=path.join(profile,"browser-stdio-owner.json"),deadline=performance.now()+8000;
    while(fs.existsSync(descriptor)&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(fs.existsSync(descriptor),false,"The owned MCP worker exits and removes its descriptor");
    assert.equal(path.dirname(fs.realpathSync(directory)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(directory).startsWith("ag-extension-worker-"));fs.rmSync(directory,{recursive:true,force:true});
  });
  assert.deepEqual(await backend.openBrowser(),{connectorStarted:true,requiresProfileConnection:true,promptSent:false});
  connection=new WebSocket(`ws://127.0.0.1:${port}/extension`,{origin:"chrome-extension://"+"b".repeat(32)});
  await new Promise<void>((resolve,reject)=>{
    connection!.once("error",reject);connection!.on("open",()=>connection!.send(JSON.stringify({type:"auth",role:"extension",...auth})));
    connection!.on("message",data=>{
      const message=JSON.parse(data.toString());if(message.type==="ready"){resolve();return;}
      commands.push(message.method);
      const result=message.method==="Connector.listTargets"?[{targetId:"tab_7",url:"https://gemini.google.com/app/fixture"}]:{result:{value:{url:"https://gemini.google.com/app/fixture",origin:"https://gemini.google.com",pathname:"/app/fixture",title:"Fixture",isAllowedSurface:true,hasComposer:true,hasSendButton:true,isGenerating:false,accountState:"signed_in",accountIdentity:identity,responseCount:0,lastResponseText:"",hasCodeBlock:false}}};
      connection!.send(JSON.stringify({id:message.id,result}));
    });
  });
  const observed=await backend.inspectIdentity(AbortSignal.timeout(5000));assert.equal(observed.accountIdentity,"a@fixture.invalid");
  await backend.prepare(AbortSignal.timeout(5000));
  identity="b@fixture.invalid";
  await assert.rejects(backend.prepare(AbortSignal.timeout(5000)),{code:"ACCOUNT_IDENTITY_CHANGED"});
  assert.equal(commands.some(method=>method.startsWith("Input.")||method==="Target.createTarget"),false);
});
