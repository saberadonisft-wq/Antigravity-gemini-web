import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { NativeSnapshotAttachmentSchema, type NativeSnapshotAttachment } from "@antigravity-gemini-web/contracts";
import type { CdpClient } from "./cdp-client.js";

export function validateNativeSnapshot(value: unknown): NativeSnapshotAttachment {
  const parsed = NativeSnapshotAttachmentSchema.safeParse(value);
  if (!parsed.success || createHash("sha256").update(parsed.data.content, "utf8").digest("hex") !== parsed.data.sha256) {
    throw { code: "INVALID_SNAPSHOT", message: "Snapshot content, digest or filename is invalid.", delivery: "not_sent", retryable: false };
  }
  return parsed.data;
}

/** Probe only the composer chips, never history text or a hidden tooltip alone. */
export function attachmentInspectionScript(fileName?: string): string {
  return `(() => {
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.height>2&&r.width>2&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.visibility!=='hidden'&&s.opacity!=='0'&&!e.closest('.cdk-visually-hidden,[hidden],[role="tooltip"]');};
    const chips=[...document.querySelectorAll('uploader-file-preview')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.height>2&&r.width>2&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'&&!e.closest('[hidden]');});
    const name=${JSON.stringify(fileName ?? null)};
    if(!name)return {count:chips.length};
    const stem=name.replace(/\\.txt$/,'');
    const descriptions=[...document.querySelectorAll('[id][role=tooltip]')].filter(e=>e.textContent?.includes(stem)).map(e=>e.id);
    const matches=chips.filter(chip=>[chip,...chip.querySelectorAll('*')].some(e=>visible(e)&&((e.getAttribute('aria-describedby')||'').split(/\\s+/).some(id=>descriptions.includes(id))||(e.children.length===0&&(e.textContent||'').includes(stem)))));
    const chip=matches.length===1?matches[0]:null;
    return {count:chips.length,matches:matches.length,ready:!!chip&&!chip.querySelector('[role=progressbar],mat-spinner,mat-progress-spinner,mat-progress-bar'),error:!!chip?.querySelector('.error-icon,[fonticon=error],[data-mat-icon-name=error]')};
  })()`;
}

export class SnapshotFileCleanupError extends Error {
  readonly code="SNAPSHOT_CLEANUP_FAILED";
  readonly retryable=false;
  constructor(readonly lease:NativeSnapshotFileLease){super("Private snapshot file cleanup did not finish; browser cleanup is required.");}
}
export class NativeSnapshotFileLease {
  #directory:string;
  #file:string;
  #disposal?:Promise<void>;
  #disposed=false;
  constructor(directory:string,fileName:string){this.#directory=directory;this.#file=path.join(directory,fileName);}
  get file(){return this.#file;}
  dispose():Promise<void>{
    if(this.#disposed)return Promise.resolve();
    if(this.#disposal)return this.#disposal;
    const pending=this.remove().then(()=>{this.#disposed=true;}).finally(()=>{this.#disposal=undefined;});this.#disposal=pending;return pending;
  }
  private async remove(){
    const normalize=(value:string)=>process.platform==="win32"?value.toLowerCase():value;
    const directory=path.resolve(this.#directory),temporary=path.resolve(os.tmpdir());
    if(normalize(path.dirname(directory))!==normalize(temporary)||!path.basename(directory).startsWith("gemini-native-snapshot-")||normalize(path.dirname(this.#file))!==normalize(directory)||!/^ag-native-context-[a-f0-9]{64}\.txt$/.test(path.basename(this.#file)))throw new SnapshotFileCleanupError(this);
    try{
      const info=await fs.lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new SnapshotFileCleanupError(this);
      if(normalize(path.dirname(await fs.realpath(directory)))!==normalize(await fs.realpath(temporary)))throw new SnapshotFileCleanupError(this);
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
    const deadline = performance.now() + 3000;
    for (;;) {
      try { await fs.rm(this.#file, { force: true });await fs.rm(path.join(this.#directory,"lease.json"),{force:true});await fs.rmdir(this.#directory);break; }
      catch(error) {
        if((error as NodeJS.ErrnoException).code==="ENOENT")return;
        if (performance.now() >= deadline) throw new SnapshotFileCleanupError(this);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}
export async function createSnapshotFile(snapshot:NativeSnapshotAttachment,targetWs?:string):Promise<NativeSnapshotFileLease>{
  const checked=validateNativeSnapshot(snapshot),directory=await fs.mkdtemp(path.join(os.tmpdir(),"gemini-native-snapshot-")),lease=new NativeSnapshotFileLease(directory,checked.fileName);
  try{
    await fs.chmod(directory,0o700);
    await fs.writeFile(path.join(directory,"lease.json"),JSON.stringify({version:1,pid:process.pid,fileName:checked.fileName,sha256:checked.sha256,createdAt:new Date().toISOString(),...(targetWs?{targetWs}:{})})+"\n",{flag:"wx",mode:0o600});
    await fs.writeFile(lease.file,checked.content,{flag:"wx",mode:0o600});return lease;
  }catch(error){await lease.dispose();throw error;}
}
export async function withSnapshotFile<T>(snapshot: NativeSnapshotAttachment, action: (file: string) => Promise<T>): Promise<T> {
  const lease=await createSnapshotFile(snapshot);
  try{return await action(lease.file);}finally{await lease.dispose();}
}

export async function uploadNativeSnapshot(cdp: CdpClient, snapshot: NativeSnapshotAttachment, check: () => Promise<void>, timeoutMs = 60000): Promise<NativeSnapshotFileLease> {
  snapshot=validateNativeSnapshot(snapshot);
  await check();
  const before = await cdp.evaluate<{count: number}>(attachmentInspectionScript());
  if (!before) throw Error("Attachment inspection was unavailable.");
  if (before.count) throw { code: "UNEXPECTED_ATTACHMENT", message: "The composer already contains an attachment.", delivery: "not_sent", retryable: false };
  const point = await cdp.evaluate<{x: number; y: number} | null>(`(() => {
    const candidates=[...document.querySelectorAll('button')].filter(e=>/^(upload & tools|tải lên và công cụ)$/i.test((e.getAttribute('aria-label')||'').trim())&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden');
    if(candidates.length!==1)return null;
    const e=candidates[0];e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;
    if(!e.contains(document.elementFromPoint(x,y)))return null;return {x,y};
  })()`);
  if (!point) throw { code: "UPLOAD_CONTROL_UNAVAILABLE", message: "A unique upload control is unavailable.", delivery: "not_sent", retryable: false };
  await check();
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  const deadline = performance.now() + timeoutMs;
  const lease=await createSnapshotFile(snapshot,cdp.wsUrl);
  try {
    let input: number | undefined;
    const inputTag = randomBytes(16).toString("hex");
    while (performance.now() < deadline) {
      await check();
      const active = await cdp.evaluate<{count:number}>(`(() => {
        const inputs=[...document.querySelectorAll('.cdk-overlay-pane images-files-uploader input[type="file"][accept*=".txt"]')].filter(e=>{const pane=e.closest('.cdk-overlay-pane'),r=pane.getBoundingClientRect(),s=getComputedStyle(pane);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!pane.closest('[hidden]');});
        if(inputs.length===1)inputs[0].setAttribute('data-ag-native-upload',${JSON.stringify(inputTag)});
        return {count:inputs.length};
      })()`);
      if (!active) throw Error("Upload input inspection was unavailable.");
      if (active.count > 1) throw { code: "UPLOAD_CONTROL_AMBIGUOUS", message: "Multiple active text upload inputs are present.", delivery: "not_sent", retryable: false };
      if (!active.count) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      const root = await cdp.send<{root: {nodeId: number}}>("DOM.getDocument", { depth: 0 });
      const inputs = await cdp.send<{nodeIds: number[]}>("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: `input[data-ag-native-upload="${inputTag}"]` });
      if (inputs.nodeIds.length > 1) throw { code: "UPLOAD_CONTROL_AMBIGUOUS", message: "Multiple text upload inputs are present.", delivery: "not_sent", retryable: false };
      if (inputs.nodeIds.length === 1) { input = inputs.nodeIds[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!input) throw { code: "UPLOAD_CONTROL_UNAVAILABLE", message: "The upload menu did not expose a text input.", delivery: "not_sent", retryable: false };
    await check();
    await cdp.send("DOM.setFileInputFiles", { files: [lease.file], nodeId: input });
    while (performance.now() < deadline) {
      await check();
      const state = await cdp.evaluate<{count:number; matches:number; ready:boolean; error:boolean}>(attachmentInspectionScript(snapshot.fileName));
      if (!state) throw Error("Attachment inspection was unavailable.");
      if (state.error) throw { code: "SNAPSHOT_UPLOAD_FAILED", message: "Gemini reported an attachment processing error.", delivery: "not_sent", retryable: false };
      if (state.count > 1 || state.matches > 1) throw { code: "UNEXPECTED_ATTACHMENT", message: "The attachment inventory changed during upload.", delivery: "not_sent", retryable: false };
      if (state.count === 1 && state.matches === 1 && state.ready) { await check(); return lease; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw { code: "SNAPSHOT_UPLOAD_TIMEOUT", message: "The attachment did not become ready within its upload budget.", delivery: "not_sent", retryable: false };
  }catch(error){await lease.dispose();throw error;}
}
