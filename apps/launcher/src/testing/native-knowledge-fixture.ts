import { KnowledgeSnapshotSchema,type NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";
export function nativeKnowledgeFixture(accounts:NativeManagementSnapshot){
  return KnowledgeSnapshotSchema.parse({service:"gemini-native-knowledge",version:1,ownerId:accounts.ownerId,revision:0,experimentalEnabled:true,canMutate:true,lastTaskScope:"a".repeat(64),sources:[{sourceId:"11111111-1111-4111-8111-111111111111",kind:"local_folder",label:"Selected project docs",revision:1,digest:"b".repeat(64),fileCount:1,bytes:12,state:"not_checked",selectedFiles:["README.md"]}],bindings:[]});
}
