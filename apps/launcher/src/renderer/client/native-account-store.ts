import { safeUiError,NativeManagementCommandSchema,type LauncherClient,type NativeManagementCommand,type NativeManagementSnapshot,type UiError } from "@antigravity-gemini-web/contracts";

type Intent<T> = T extends unknown?Omit<T,"expectedOwnerId"|"expectedRevision"|"expectedRoutingRevision">:never;
export type NativeAccountIntent=Intent<NativeManagementCommand>;
export interface NativeAccountViewState {snapshot?:NativeManagementSnapshot;fresh:boolean;loading:boolean;pendingAction?:NativeManagementCommand["action"]|"pair";error?:UiError;notice?:NativeManagementCommand["action"]|"pair"}

/** Late status reads cannot overwrite a completed selection or revive a disposed view. */
export class NativeAccountStore {
  private state:NativeAccountViewState={fresh:false,loading:true};
  private listeners=new Set<(state:NativeAccountViewState)=>void>();
  private generation=0;private disposed=false;private timer?:ReturnType<typeof setInterval>;private reading=false;private chatOffset=0;
  constructor(private readonly client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">){}
  get current(){return structuredClone(this.state);}
  listen(listener:(state:NativeAccountViewState)=>void){this.listeners.add(listener);listener(this.current);return ()=>{this.listeners.delete(listener);};}
  private update(patch:Partial<NativeAccountViewState>){if(this.disposed)return;this.state={...this.state,...patch};for(const listener of this.listeners)listener(this.current);}
  start(){void this.refresh();this.timer=setInterval(()=>{void this.refresh();},3000);}
  async refresh(){
    if(this.disposed||this.reading||this.state.pendingAction)return;
    const generation=this.generation;this.reading=true;
    try{
      if(!this.client.getNativeAccounts)throw {code:"UNSUPPORTED_OPERATION"};
      const snapshot=await this.client.getNativeAccounts(this.chatOffset);
      if(generation===this.generation){
        const previous=this.state.snapshot,sameTurn=snapshot.lastOutcome?.requestId===previous?.lastOutcome?.requestId;
        const changed=snapshot.ownerId!==previous?.ownerId||snapshot.revision!==previous?.revision||!sameTurn||snapshot.lastOutcome?.phase!==previous?.lastOutcome?.phase;
        const preserveCancellation=this.state.notice==="cancel"&&sameTurn&&snapshot.ownerId===previous?.ownerId&&snapshot.revision===previous?.revision;
        this.update({snapshot,fresh:true,loading:false,error:undefined,notice:changed&&!preserveCancellation?undefined:this.state.notice});
      }
    }catch(error){if(generation===this.generation)this.update({fresh:false,loading:false,error:safeUiError(error),notice:undefined});}
    finally{this.reading=false;}
  }
  async execute(intent:NativeAccountIntent):Promise<boolean>{
    const snapshot=this.state.snapshot,age=snapshot?Date.now()-Date.parse(snapshot.observedAt):Infinity;
    if(this.disposed||this.state.pendingAction)return false;
    if(!this.state.fresh||!snapshot||age<0||age>10000){this.update({fresh:false,error:safeUiError({code:"RUNTIME_DISCONNECTED"})});return false;}
    if(!snapshot.canMutate&&intent.action!=="cancel"){this.update({error:safeUiError({code:"BUSY"})});return false;}
    ++this.generation;this.update({pendingAction:intent.action,error:undefined,notice:undefined});
    try{
      if(!this.client.executeNativeAccount)throw {code:"UNSUPPORTED_OPERATION"};
      const command=NativeManagementCommandSchema.parse({...intent,expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision,...(intent.action==="unbind"||intent.action==="remove"||intent.action==="configure_routing"?{expectedRoutingRevision:snapshot.routing.revision}:{})});
      const result=await this.client.executeNativeAccount(command);
      this.chatOffset=0;this.update({snapshot:result,fresh:true,pendingAction:undefined,notice:intent.action,loading:false});return true;
    }catch(error){this.update({fresh:false,pendingAction:undefined,error:safeUiError(error),loading:false});return false;}
  }
  async copyPairingCode(accountId:string):Promise<boolean>{
    const snapshot=this.state.snapshot,age=snapshot?Date.now()-Date.parse(snapshot.observedAt):Infinity;
    if(this.disposed||this.state.pendingAction)return false;
    if(!this.state.fresh||!snapshot||age<0||age>10000){this.update({fresh:false,error:safeUiError({code:"RUNTIME_DISCONNECTED"})});return false;}
    const account=snapshot.accounts.find(row=>row.accountId===accountId);
    if(!snapshot.canMutate){this.update({error:safeUiError({code:"BUSY"})});return false;}
    if(!account?.enabled||account.browserTransport!=="extension"){this.update({error:safeUiError({code:"INVALID_ARGUMENT"})});return false;}
    ++this.generation;this.update({pendingAction:"pair",error:undefined,notice:undefined});
    try{
      if(!this.client.copyNativeExtensionPairingCode)throw {code:"UNSUPPORTED_OPERATION"};
      await this.client.copyNativeExtensionPairingCode({accountId,expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision});
      this.update({fresh:true,pendingAction:undefined,notice:"pair",loading:false});return true;
    }catch(error){this.update({fresh:false,pendingAction:undefined,error:safeUiError(error),loading:false});return false;}
  }
  async page(offset:number){if(this.reading||this.state.pendingAction||!Number.isInteger(offset)||offset<0||offset>2048)return;this.chatOffset=offset;++this.generation;await this.refresh();}
  dispose(){this.disposed=true;++this.generation;clearInterval(this.timer);this.listeners.clear();}
}
