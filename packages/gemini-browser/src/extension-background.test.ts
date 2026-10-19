import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../../../extensions/chrome-profile-connector/background.js", import.meta.url), "utf8");
test("Chrome extension service worker source does not use disallowed top-level await", () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: "background.js" }));
});
async function extensionFixture() {
  const listeners: Record<string, Function> = {}, requests: any[] = [], attached: number[] = [], detached: number[] = [], removed: number[] = [], created: any[] = [], sockets: FakeSocket[] = [];
  const tabs = new Map([[1,{id:1,url:"https://gemini.google.com/app/user",incognito:false}],[2,{id:2,url:"https://accounts.google.com/",incognito:false}]]);
  const configuration = {version:1,profileId:"11111111-1111-1111-1111-111111111111",token:"a".repeat(64),port:9223,name:"Profile A"};
  let attachmentGate: Promise<void> | undefined;
  class FakeSocket {
    static OPEN=1;readyState=0;sent:any[]=[];onopen?:Function;onmessage?:Function;onclose?:Function;onerror?:Function;
    constructor(public url:string){sockets.push(this);}
    send(value:string){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;this.onclose?.();}
    open(){this.readyState=1;this.onopen?.();}
    async receive(value:unknown){await this.onmessage?.({data:JSON.stringify(value)});}
  }
  const api = {
    runtime:{id:"a".repeat(32),getURL:(name:string)=>"chrome-extension://"+"a".repeat(32)+"/"+name,onMessage:{addListener:(fn:Function)=>listeners.message=fn}},
    storage:{local:{setAccessLevel:async()=>{},get:async()=>({configuration}),set:async()=>{}}},action:{setBadgeText:async()=>{}},
    debugger:{attach:async({tabId}:{tabId:number})=>{attached.push(tabId);await attachmentGate;},detach:async({tabId}:{tabId:number})=>{detached.push(tabId);},sendCommand:async(target:unknown,method:string,params:any)=>{requests.push({target,method,params});return {result:{value:"ok"}};},onDetach:{addListener:(fn:Function)=>listeners.detach=fn}},
    tabs:{query:async()=>[...tabs.values()],get:async(id:number)=>{const tab=tabs.get(id);if(!tab)throw Error("missing");return tab;},create:async(value:any)=>{created.push(value);const tab={id:3,url:value.url,incognito:false};tabs.set(3,tab);return tab;},remove:async(id:number)=>{removed.push(id);tabs.delete(id);listeners.detach?.({tabId:id},"target_closed");},onRemoved:{addListener:(fn:Function)=>listeners.removed=fn},onUpdated:{addListener:(fn:Function)=>listeners.updated=fn}},
  };
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction("chrome","WebSocket","setInterval","clearInterval",source)(api,FakeSocket,()=>1,()=>{});
  const ui = (action:string,extra:object={}) => new Promise<any>(resolve=>listeners.message({action,...extra},{id:api.runtime.id,url:api.runtime.getURL("popup.html")},resolve));
  await ui("connect");const socket=sockets[0];socket.open();
  assert.equal((await ui("status")).connected,false,"WebSocket open alone is not authenticated readiness");
  await socket.receive({type:"ready",profileId:configuration.profileId});
  const command = async(method:string,params:unknown={},targetId?:string)=>{const id=socket.sent.length+1;await socket.receive({id,method,params,targetId});return [...socket.sent].reverse().find(message=>message.id===id);};
  return {ui,socket,command,requests,attached,detached,removed,created,tabs,listeners,setGate:(value:Promise<void>)=>attachmentGate=value};
}
test("Extension confines commands to Gemini, preserves user tabs and rejects local-file uploads",async()=>{
  const f=await extensionFixture();assert.equal((await f.ui("status")).connected,true);
  assert.deepEqual((await f.command("Connector.listTargets")).result,[{targetId:"tab_1",url:"https://gemini.google.com/app/user"}]);
  assert.ok((await f.command("Target.createTarget",{url:"https://accounts.google.com/"})).error);assert.equal(f.created.length,0);
  assert.ok((await f.command("Target.closeTarget",{targetId:"tab_1"})).error);assert.deepEqual(f.removed,[]);
  assert.ok((await f.command("Runtime.evaluate",{expression:"location.href"},"tab_2")).error);assert.equal(f.requests.length,0);
  assert.ok((await f.command("DOM.setFileInputFiles",{files:["private.txt"]},"tab_1")).error);assert.deepEqual(f.attached,[]);
  assert.deepEqual((await f.command("Target.createTarget",{url:"https://gemini.google.com/app"})).result,{targetId:"tab_3"});
  assert.equal(f.created[0].active,false);
  await f.command("Runtime.evaluate",{expression:"(() => 'marker')();"},"tab_3");
  assert.equal(f.requests.length,1);assert.match(f.requests[0].params.expression,/^if\(location.origin/);assert.match(f.requests[0].params.expression,/marker/);
  await f.command("Target.closeTarget",{targetId:"tab_3"});assert.deepEqual(f.removed,[3]);assert.equal((await f.ui("status")).connected,true,"Normal owned-tab cleanup preserves the profile connection");
  await f.ui("disconnect");
});
test("Disconnect during attach fences late callbacks and detaches without inserting text",async()=>{
  const f=await extensionFixture();let release!:()=>void;f.setGate(new Promise<void>(resolve=>release=resolve));
  const operation=f.command("Input.insertText",{text:"must never be entered"},"tab_1");
  while(!f.attached.length)await new Promise(resolve=>setTimeout(resolve,1));
  await f.ui("disconnect");release();await operation;
  assert.deepEqual(f.requests,[]);assert.deepEqual(f.detached,[1]);assert.equal((await f.ui("status")).connected,false);
});
