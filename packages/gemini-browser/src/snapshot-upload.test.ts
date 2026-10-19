import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { NativeSnapshotAttachmentSchema } from "@antigravity-gemini-web/contracts";
import { validateNativeSnapshot, withSnapshotFile, uploadNativeSnapshot, createSnapshotFile } from "./snapshot-upload.js";
import type { CdpClient } from "./cdp-client.js";

function snapshot(content = "Synthetic Việt 😀 context") {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { version: 1 as const, mediaType: "text/plain" as const, fileName: `ag-native-context-${sha256}.txt`, sha256, content };
}

test("Snapshot contract rejects paths, malformed Unicode, oversize content and mismatched bytes before file creation", () => {
  const valid = snapshot(); assert.deepEqual(validateNativeSnapshot(valid), valid);
  for (const value of [{ ...valid, path: "C:/private.txt" }, { ...valid, fileName: "../private.txt" }, { ...valid, content: "changed" }, snapshot("\ud800"), snapshot("\udfff"), snapshot("x".repeat(262145))]) {
    assert.throws(() => validateNativeSnapshot(value), { code: "INVALID_SNAPSHOT" });
  }
  assert.ok(NativeSnapshotAttachmentSchema.safeParse(snapshot("x".repeat(262142) + "😀")).success);
});

test("Private temporary snapshot preserves exact UTF-8 bytes and removes its file and directory on success and failure", async () => {
  for (const fail of [false, true]) {
    let created = "";
    const operation = withSnapshotFile(snapshot(), async file => {
      created = file;
      assert.equal(await fs.readFile(file, "utf8"), snapshot().content);
      if (fail) throw Error("Synthetic action failure");
      return 42;
    });
    if (fail) await assert.rejects(operation, /Synthetic action failure/); else assert.equal(await operation, 42);
    await assert.rejects(fs.stat(created), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.dirname(created)), { code: "ENOENT" });
  }
});

function uploadFixture(states: Array<{count:number;matches:number;ready:boolean;error:boolean}>, hooks: { set?: () => void; ambiguous?: boolean } = {}) {
  let inspections = 0, file = "", assigns = 0;
  const cdp = {
    evaluate: async (script:string) => script.includes("data-ag-native-upload") ? {count:hooks.ambiguous?2:1} : ++inspections === 1 ? { count: 0 } : inspections === 2 ? { x: 20, y: 20 } : states.shift() ?? { count: 0, matches: 0, ready: false, error: false },
    send: async (method: string, args: {files?: string[]}) => {
      if (method === "DOM.getDocument") return { root: {nodeId: 1} };
      if (method === "DOM.querySelectorAll") return { nodeIds: hooks.ambiguous ? [2, 3] : [2] };
      if (method === "DOM.setFileInputFiles") { file = args.files![0]; assigns++; assert.equal(await fs.readFile(file, "utf8"), snapshot().content); hooks.set?.(); }
      return {};
    },
  } as unknown as CdpClient;
  return { cdp, file: () => file, assigns: () => assigns };
}

test("Upload waits for the exact chip to finish processing and cleans its temporary file", async () => {
  const f = uploadFixture([{count:1,matches:1,ready:false,error:false}, {count:1,matches:1,ready:true,error:false}]);
  const lease=await uploadNativeSnapshot(f.cdp, snapshot(), async () => {});
  assert.equal(f.assigns(), 1);assert.equal(await fs.readFile(f.file(),"utf8"),snapshot().content);
  await lease.dispose();await lease.dispose();await assert.rejects(fs.stat(f.file()), {code:"ENOENT"});
});

test("Upload cancellation, processing errors, duplicate controls and timeout never report readiness or retain a temp file", async () => {
  for (const kind of ["cancel", "error", "duplicate", "timeout"] as const) {
    let cancelled = false;
    const f = uploadFixture([{count:1,matches:1,ready:kind !== "timeout",error:kind === "error"}], { ambiguous: kind === "duplicate", set: () => { cancelled = kind === "cancel"; } });
    await assert.rejects(uploadNativeSnapshot(f.cdp, snapshot(), async () => { if (cancelled) throw {code:"CANCELLED"}; }, kind === "timeout" ? 300 : 2000), {code: kind === "cancel" ? "CANCELLED" : kind === "error" ? "SNAPSHOT_UPLOAD_FAILED" : kind === "duplicate" ? "UPLOAD_CONTROL_AMBIGUOUS" : "SNAPSHOT_UPLOAD_TIMEOUT"});
    if (f.file()) await assert.rejects(fs.stat(f.file()), {code:"ENOENT"});
  }
});


test("Invalid upload content is rejected before any DOM operation",async()=>{
  let operations=0;const cdp={evaluate:async()=>{operations++;},send:async()=>{operations++;}} as unknown as CdpClient;
  await assert.rejects(uploadNativeSnapshot(cdp,{...snapshot(),content:"different bytes"},async()=>{}),{code:"INVALID_SNAPSHOT"});assert.equal(operations,0);
});

test("A snapshot lease retains its owner ticket and can retry exact-file cleanup after a transient lock",{timeout:10000},async t=>{
  const lease=await createSnapshotFile(snapshot());
  t.after(async()=>{t.mock.restoreAll();await lease.dispose();});
  const ticket=JSON.parse(await fs.readFile(path.join(path.dirname(lease.file),"lease.json"),"utf8"));assert.equal(ticket.pid,process.pid);assert.equal(ticket.sha256,snapshot().sha256);assert.ok(!JSON.stringify(ticket).includes(snapshot().content));
  t.mock.method(fs,"rm",async()=>{throw Object.assign(Error("Synthetic lock"),{code:"EBUSY"});});
  await assert.rejects(lease.dispose(),{code:"SNAPSHOT_CLEANUP_FAILED"});assert.equal(await fs.readFile(lease.file,"utf8"),snapshot().content);
  t.mock.restoreAll();await lease.dispose();await assert.rejects(fs.stat(lease.file),{code:"ENOENT"});
});
