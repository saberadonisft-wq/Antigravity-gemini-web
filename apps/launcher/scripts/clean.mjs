import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
// Only reproducible compiler output under this launcher, never live account data.
for(const name of ["dist","dist-renderer","dist-acceptance","tsconfig.tsbuildinfo"]){
 const target=path.resolve(root,name);
 if(path.dirname(target)!==root||fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error("Unexpected build output target");
 fs.rmSync(target,{recursive:true,force:true});
}
