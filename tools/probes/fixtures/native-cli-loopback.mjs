// Test preloader only. Production CLI source, with isolated home and loopback transport.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const root=fs.realpathSync(process.env.AG_NATIVE_CLI_FIXTURE_ROOT??"");
if(path.dirname(root).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(root).startsWith("launcher-smoke-native-lifecycle-"))throw Error("Owned fixture root required");
const fixture=JSON.parse(fs.readFileSync(path.join(root,"cli-fixture.json"),"utf8")),endpoint=new URL(fixture.endpoint);
if(endpoint.protocol!=="http:"||endpoint.hostname!=="127.0.0.1"||!endpoint.port||endpoint.pathname!=="/"||endpoint.search||endpoint.hash||fixture.home!==path.join(root,"home"))throw Error("Invalid loopback fixture");
os.homedir=()=>fixture.home;syncBuiltinESMExports();
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!=="http://127.0.0.1:9236"||!url.pathname.startsWith("/__native/"))throw Error("External CLI transport forbidden in fixture");
  return originalFetch(endpoint.origin+url.pathname+url.search,{...options,redirect:"error"});
};
