import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
for(const parent of ["packages","apps"]){
 for(const item of fs.readdirSync(path.join(root,parent),{withFileTypes:true})){
  if(!item.isDirectory()||item.isSymbolicLink())continue;
  const workspace=path.join(root,parent,item.name);
  if(!fs.existsSync(path.join(workspace,"package.json")))continue;
  for(const name of ["dist","dist-renderer","dist-acceptance","tsconfig.tsbuildinfo"]){
   const target=path.resolve(workspace,name);
   if(path.dirname(target)!==workspace||fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error("Unexpected compiler output path");
   fs.rmSync(target,{recursive:true,force:true});
  }
 }
}
