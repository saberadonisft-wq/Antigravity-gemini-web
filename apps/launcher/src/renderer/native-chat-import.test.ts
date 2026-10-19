import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChatImportSnapshot, ChatImportIntent, ChatImportUiCommand, LauncherClient } from "@antigravity-gemini-web/contracts";
import { MockLauncherClient } from "./client/mock-client.js";
import { NativeChatImportStore } from "./client/native-chat-import-store.js";
import { nativeAccountFixture } from "../testing/native-account-fixture.js";
import { IpcSecurityBridge } from "../main/ipc-bridge.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const accounts = nativeAccountFixture({ runtimeRevision: 38 }), snapshot: ChatImportSnapshot = { service: "gemini-native-chat-import", version: 1, ownerId: accounts.ownerId, revision: 0, accountRevision: accounts.revision, experimentalEnabled: true, canInspect: true, inspectionActive: false, jobs: [], googleSubmission: "not_submitted" };
  const commands: ChatImportIntent[] = [], updates: ChatImportUiCommand[] = [], client: LauncherClient = new MockLauncherClient(); let now = 0;
  client.getNativeAccounts = async () => structuredClone(accounts); client.getNativeChatImports = async () => structuredClone(snapshot);
  client.inspectNativeChatImport = async command => { commands.push(command); snapshot.revision++; return structuredClone(snapshot); };
  client.executeNativeChatImport = async command => { updates.push(command); snapshot.revision++; return structuredClone(snapshot); };
  return { accounts, snapshot, commands, updates, client, store: new NativeChatImportStore(client, () => now), advance: (value: number) => { now += value; } };
}
test("Import selection captures account/epoch authority once and late reads cannot overwrite its result", async () => {
  const f = fixture(); await f.store.refresh(); const old = deferred<ChatImportSnapshot>(), mutation = deferred<ChatImportSnapshot>(); let reads = 0;
  f.client.getNativeChatImports = async () => ++reads === 1 ? old.promise : structuredClone(f.snapshot);
  f.client.inspectNativeChatImport = async command => { f.commands.push(command); return mutation.promise; };
  const poll = f.store.refresh(), selected = f.store.inspect(f.accounts.accounts[0]!.accountId, 1, "chatgpt");
  await f.store.inspect(f.accounts.accounts[0]!.accountId, 1, "claude"); assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]!.expectedOwnerId, f.accounts.ownerId); assert.equal(f.commands[0]!.expectedAccountRevision, 1); assert.equal(f.commands[0]!.identityEpoch, 1);
  f.snapshot.revision = 1; mutation.resolve(structuredClone(f.snapshot)); await selected; old.resolve({ ...f.snapshot, revision: 0 }); await poll;
  assert.equal(f.store.current.snapshot!.revision, 1); assert.equal(f.commands.length, 1); f.store.dispose();
});
test("Disabled identity, stale status and mixed owner reads never open a picker; cancel stays available during a Native turn", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.inspect(f.accounts.accounts[1]!.accountId, 0, "chatgpt"); assert.equal(f.commands.length, 0);
  f.accounts.canMutate = false; await f.store.refresh(); await f.store.inspect(f.accounts.accounts[0]!.accountId, 1, "chatgpt"); assert.equal(f.commands.length, 0);
  await f.store.execute("cancel", randomUUID()); assert.equal(f.updates.length, 1);
  f.advance(11000); await f.store.inspect(f.accounts.accounts[0]!.accountId, 1, "chatgpt"); assert.equal(f.commands.length, 0); assert.equal(f.store.current.fresh, false);
  f.snapshot.ownerId = randomUUID(); await f.store.refresh(); assert.equal(f.store.current.fresh, false); f.store.dispose();
});
test("A disposed import view ignores late picker results without retrying the operation", async () => {
  const f = fixture(); await f.store.refresh(); const pending = deferred<ChatImportSnapshot>();
  f.client.inspectNativeChatImport = async command => { f.commands.push(command); return pending.promise; };
  const selected = f.store.inspect(f.accounts.accounts[0]!.accountId, 1, "chatgpt"); f.store.dispose(); pending.resolve({ ...f.snapshot, revision: 2 }); await selected;
  assert.equal(f.commands.length, 1); assert.equal(f.store.current.snapshot!.revision, 0);
});
test("Import IPC denies arbitrary paths, payloads, subframes, extra args and renderer upload commands", async () => {
  const f = fixture(); let pickers = 0;
  const bridge = new IpcSecurityBridge({ backend: f.client, nativeChatImports: { getNativeChatImports: f.client.getNativeChatImports!, executeNativeChatImport: f.client.executeNativeChatImport! }, onInspectChatImport: async () => { pickers++; return f.snapshot; }, trustedSender: sender => sender.id === 9 });
  const context = { sender: { id: 9, send: () => {} }, isMainFrame: true, origin: "app://local" };
  const intent: ChatImportIntent = { expectedOwnerId: f.accounts.ownerId, expectedRevision: 0, expectedAccountRevision: 1, accountId: f.accounts.accounts[0]!.accountId, identityEpoch: 1, provider: "chatgpt" };
  for (const patch of [{ file: "C:\\private\\anything.zip" }, { paths: ["anything"] }, { contents: "untrusted export" }, { action: "upload" }]) assert.equal((await bridge.invoke("launcher:inspectNativeChatImport", context, { ...intent, ...patch })).ok, false);
  assert.equal((await bridge.invoke("launcher:inspectNativeChatImport", { ...context, isMainFrame: false }, intent)).ok, false);
  assert.equal((await bridge.invoke("launcher:getNativeChatImports", context, "extra")).ok, false);
  assert.equal(pickers, 0); assert.equal((await bridge.invoke("launcher:inspectNativeChatImport", context, intent)).ok, true); assert.equal(pickers, 1);
});
