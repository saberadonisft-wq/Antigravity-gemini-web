import { safeUiError,KnowledgeUiCommandSchema,KnowledgeImportIntentSchema,type LauncherClient,type KnowledgeSnapshot,type KnowledgeUiCommand,type NativeManagementSnapshot,type UiError } from "@antigravity-gemini-web/contracts";

type Intent<T>=T extends unknown?Omit<T,"expectedOwnerId"|"expectedRevision">:never;
export type NativeKnowledgeIntent=Intent<KnowledgeUiCommand>;
export interface NativeKnowledgeViewState {snapshot?:KnowledgeSnapshot;accounts?:NativeManagementSnapshot;fresh:boolean;loading:boolean;pending?:KnowledgeUiCommand["action"]|"import_code";notice?:string;error?:UiError}

/** UI owns drafts; this store owns current authority and never retries a mutation. */
export class NativeKnowledgeStore {
  private state:NativeKnowledgeViewState={fresh:false,loading:true};
  private listeners=new Set<(state:NativeKnowledgeViewState)=>void>();
  private disposed=false;private generation=0;private reading=false;private observedAt=0;private timer?:ReturnType<typeof setInterval>;
  constructor(private readonly client:LauncherClient){}
  get current(){return structuredClone(this.state);}
  listen(listener:(state:NativeKnowledgeViewState)=>void){this.listeners.add(listener);listener(this.current);return ()=>{this.listeners.delete(listener);};}
  private update(patch:Partial<NativeKnowledgeViewState>){if(this.disposed)return;this.state={...this.state,...patch};for(const listener of this.listeners)listener(this.current);}
  start(){void this.refresh();this.timer=setInterval(()=>{void this.refresh();},3000);}
  async refresh(){
    if(this.disposed||this.reading||this.state.pending)return;this.reading=true;const generation=this.generation;
    try{
      if(!this.client.getNativeKnowledge||!this.client.getNativeAccounts)throw {code:"UNSUPPORTED_OPERATION"};
      const [snapshot,accounts]=await Promise.all([this.client.getNativeKnowledge(),this.client.getNativeAccounts()]);
      if(snapshot.ownerId!==accounts.ownerId)throw {code:"STALE_AUTHORITY"};
      if(generation===this.generation){const changed=snapshot.ownerId!==this.state.snapshot?.ownerId||snapshot.revision!==this.state.snapshot?.revision||accounts.revision!==this.state.accounts?.revision;this.observedAt=Date.now();this.update({snapshot,accounts,fresh:true,loading:false,error:undefined,notice:changed?undefined:this.state.notice});}
    }catch(error){if(generation===this.generation)this.update({fresh:false,loading:false,error:safeUiError(error),notice:undefined});}
    finally{this.reading=false;}
  }
  private authority(){
    const {snapshot,accounts}=this.state,age=Date.now()-this.observedAt;
    if(this.disposed||this.state.pending)return;
    if(!this.state.fresh||!snapshot||!accounts||age<0||age>10000){this.update({fresh:false,error:safeUiError({code:"RUNTIME_DISCONNECTED"}),notice:undefined});return;}
    if(!snapshot.experimentalEnabled){this.update({error:safeUiError({code:"SOURCE_EXPERIMENT_DISABLED"})});return;}
    if(!snapshot.canMutate||!accounts.canMutate){this.update({error:safeUiError({code:"BUSY"})});return;}
    return {expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision};
  }
  private async run(action:NonNullable<NativeKnowledgeViewState["pending"]>,operation:()=>Promise<KnowledgeSnapshot>){
    ++this.generation;this.update({pending:action,error:undefined,notice:undefined});
    try{
      const snapshot=await operation();if(snapshot.ownerId!==this.state.accounts?.ownerId)throw {code:"STALE_AUTHORITY"};
      this.update({snapshot,fresh:false,pending:undefined,loading:false,notice:action});await this.refresh();return true;
    }catch(error){const safe=safeUiError(error);this.update({fresh:false,pending:undefined,loading:false,error:safe.code==="CANCELLED"?undefined:safe,notice:safe.code==="CANCELLED"?"cancelled":undefined});if(safe.code==="CANCELLED")await this.refresh();return false;}
  }
  execute(intent:NativeKnowledgeIntent){
    const authority=this.authority();if(!authority)return Promise.resolve(false);
    return this.run(intent.action,async()=>{
      if(!this.client.executeNativeKnowledge)throw {code:"UNSUPPORTED_OPERATION"};
      const command=KnowledgeUiCommandSchema.parse({...intent,...authority});
      if(command.action==="bind"){
        const account=this.state.accounts?.accounts.find(item=>item.accountId===command.accountId);
        if(!account?.enabled||!account.identityRegistered||account.identityEpoch!==command.identityEpoch)throw {code:"STALE_AUTHORITY"};
      }
      return this.client.executeNativeKnowledge(command);
    });
  }
  importFiles(label:string){
    const authority=this.authority();if(!authority)return Promise.resolve(false);
    return this.run("import_code",async()=>{if(!this.client.importNativeKnowledge)throw {code:"UNSUPPORTED_OPERATION"};return this.client.importNativeKnowledge(KnowledgeImportIntentSchema.parse({label,...authority}));});
  }
  dispose(){this.disposed=true;++this.generation;clearInterval(this.timer);this.listeners.clear();}
}
