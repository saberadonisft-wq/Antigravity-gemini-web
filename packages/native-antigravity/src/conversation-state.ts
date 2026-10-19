import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { canonical, NativeRouteError, sha256, type JsonObject } from "./native-protocol.js";
import { applyContextPatch, contextPatch, wireValue, type ContextPatch } from "./context-patch.js";
import { validUnicodePrefix } from "./unicode.js";
import { atomicPrivateFile, assertNoLinks } from "./installation.js";

export interface NativeContext {
  systemInstruction?: unknown;
  contents: unknown[];
  tools: unknown[];
  toolConfig?: unknown;
  generationConfig?: unknown;
  knowledge?: unknown;
}
export interface NativeConversationPlan {
  accountId: string;
  identityEpoch: number;
  surface: string;
  key: string;
  reservation: string;
  revision: string;
  expectedRevision?: string;
  baseRevision?: string;
  appendFrom: number;
  context: NativeContext;
  retiredKeys: string[];
  mode: "full" | "append" | "patch" | "replace";
  patches?: ContextPatch[];
  resumeUrl?: string;
}
type State = { retired?: boolean; resolvesLegacyKeys?: string[]; taskKey: string; accountId: string; identityEpoch: number; surface: string; key: string; context?: NativeContext; revision?: string; resumeUrl?: string; pending?: string; pendingRevision?: string; outcomeUnknown?: boolean; updatedAt?: string };
type PersistedEntry = { retired?: boolean; taskKey: string; key: string; accountId?: string; identityEpoch?: number; surface?: string; revision?: string; contextHash?: string; resumeUrl?: string; pendingRevision?: string; outcomeUnknown: boolean; updatedAt: string };
const GEMINI_CONVERSATION_URL = /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/;
const PERSISTED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Failed tasks keep durable replay fences without occupying a live tab slot.
const MAX_PERSISTED_NATIVE_TASKS = 2048;

/** One exact task owns a canonical snapshot; updates are lossless and revision-bound. */
export class NativeConversationState {
  private states = new Map<string, State>();
  constructor(private readonly capacity = 5, private readonly filename?: string) {
    if (!filename || !fs.existsSync(filename)) return;
    assertNoLinks(filename);
    let raw: unknown, originalBytes: string;
    try { originalBytes = fs.readFileSync(filename, "utf8"); raw = JSON.parse(originalBytes); } catch { throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved conversation metadata is unreadable; no browser prompt was sent.", 503); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![1, 2].includes((raw as any).version) || !Array.isArray((raw as any).entries) || (raw as any).entries.length > MAX_PERSISTED_NATIVE_TASKS) {
      throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved conversation metadata has an unsupported shape; no browser prompt was sent.", 503);
    }
    const seenKeys = new Set<string>(); let expired = false;
    for (const candidate of (raw as { entries: unknown[] }).entries) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved conversation metadata is invalid; no browser prompt was sent.", 503);
      const entry = candidate as Partial<PersistedEntry>;
      const stableMetadata = entry.revision === undefined && entry.contextHash === undefined || typeof entry.revision === "string" && /^[a-f0-9]{64}$/.test(entry.revision) && entry.contextHash === entry.revision;
      const validUrl = entry.resumeUrl === undefined || typeof entry.resumeUrl === "string" && GEMINI_CONVERSATION_URL.test(entry.resumeUrl);
      const validPending = entry.pendingRevision === undefined || typeof entry.pendingRevision === "string" && /^[a-f0-9]{64}$/.test(entry.pendingRevision);
      const validAccountId = entry.accountId === undefined || (typeof entry.accountId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.accountId));
      const validEpoch = entry.identityEpoch === undefined || Number.isSafeInteger(entry.identityEpoch) && entry.identityEpoch >= 0;
      const validRetired = entry.retired === undefined || typeof entry.retired === "boolean";
      const validSurface = entry.surface === undefined || ["chat", "gem", "notebook"].includes(entry.surface);
      const expectedKeys = ["taskKey", "key", "updatedAt", "outcomeUnknown", ...(entry.revision !== undefined ? ["revision"] : []), ...(entry.contextHash !== undefined ? ["contextHash"] : []), ...(entry.resumeUrl !== undefined ? ["resumeUrl"] : []), ...(entry.pendingRevision !== undefined ? ["pendingRevision"] : []), ...(entry.accountId !== undefined ? ["accountId"] : []), ...(entry.identityEpoch !== undefined ? ["identityEpoch"] : []), ...(entry.surface !== undefined ? ["surface"] : []), ...(entry.retired !== undefined ? ["retired"] : [])].sort().join(",");
      const bindingKey = canonical([entry.taskKey, entry.accountId ?? "default", entry.identityEpoch ?? 0, entry.surface ?? "chat"]);
      if (typeof entry.taskKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.taskKey) || typeof entry.key !== "string" || !/^[a-zA-Z0-9_-]{8,96}$/.test(entry.key) ||
        !stableMetadata || !validUrl || !validPending || !validAccountId || !validEpoch || !validSurface || !validRetired || typeof entry.outcomeUnknown !== "boolean" ||
        typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)) || (!entry.revision && !entry.resumeUrl && !entry.pendingRevision && !entry.outcomeUnknown) ||
        Object.keys(candidate).sort().join(",") !== expectedKeys ||
        this.states.has(bindingKey) || seenKeys.has(entry.key)) {
        throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved conversation metadata failed validation; no browser prompt was sent.", 503);
      }
      const updatedAt = Date.parse(entry.updatedAt);
      if (updatedAt > Date.now() + 5 * 60 * 1000) throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved conversation metadata timestamp is invalid; no browser prompt was sent.", 503);
      const interrupted = !!entry.pendingRevision || entry.outcomeUnknown;
      if (!interrupted && !entry.retired && entry.accountId !== undefined && Date.now() - updatedAt > PERSISTED_CACHE_TTL_MS) { expired = true; continue; }
      seenKeys.add(entry.key);
      this.states.set(bindingKey, { retired: entry.retired, taskKey: entry.taskKey, accountId: entry.accountId ?? "default", identityEpoch: entry.identityEpoch ?? 0, surface: entry.surface ?? "chat", key: entry.key, revision: entry.revision, resumeUrl: entry.resumeUrl, pendingRevision: interrupted ? entry.pendingRevision : undefined, outcomeUnknown: interrupted, updatedAt: entry.updatedAt });
    }
    if ([...this.states.values()].filter(value => !value.outcomeUnknown && !value.retired).length > capacity) throw new NativeRouteError("INVALID_CONVERSATION_CACHE", "Saved live conversations exceed the configured capacity.", 503);
    if ((raw as any).version === 1) {
      const backup = filename + ".v1.backup"; assertNoLinks(backup);
      if (!fs.existsSync(backup)) atomicPrivateFile(backup, originalBytes!);
      this.persist();
    } else if (expired) this.persist();
  }
  private persist() {
    if (!this.filename) return;
    const entries: PersistedEntry[] = [...this.states.values()].flatMap(state => state.retired || state.outcomeUnknown || state.pendingRevision || state.resumeUrl ? [{
      taskKey: state.taskKey, key: state.key, ...(state.retired ? { retired: true } : {}), identityEpoch: state.identityEpoch, surface: state.surface, ...(state.accountId && state.accountId !== "default" ? { accountId: state.accountId } : {}), ...(state.revision ? { revision: state.revision, contextHash: state.revision } : {}), ...(state.resumeUrl ? { resumeUrl: state.resumeUrl } : {}),
      ...(state.pendingRevision ? { pendingRevision: state.pendingRevision } : {}), outcomeUnknown: !!state.outcomeUnknown, updatedAt: state.updatedAt ?? new Date().toISOString(),
    }] : []);
    assertNoLinks(this.filename);
    if (!entries.length) { if (fs.existsSync(this.filename)) fs.unlinkSync(this.filename); return; }
    atomicPrivateFile(this.filename, JSON.stringify({ version: 2, entries }) + "\n");
  }
  prepare(taskKey: string | undefined, context: NativeContext, rebind = false, explicitResumeUrl?: string, accountId = "default", identityEpoch = 0, surface = "chat"): NativeConversationPlan | undefined {
    if (explicitResumeUrl !== undefined && !GEMINI_CONVERSATION_URL.test(explicitResumeUrl)) throw new NativeRouteError("INVALID_CONVERSATION_URL", "Resume URL is not a canonical Gemini conversation.", 400);
    if (!taskKey) return undefined;
    context = wireValue(context);
    if (!Number.isSafeInteger(identityEpoch) || identityEpoch < 0 || !["chat", "gem", "notebook"].includes(surface)) throw new NativeRouteError("INVALID_BINDING", "Invalid account epoch or surface.");
    const bindingKey = canonical([taskKey, accountId, identityEpoch, surface]);
    let state = this.states.get(bindingKey);
    const taskStates = [...this.states.values()].filter(value => value.taskKey === taskKey);
    if (taskStates.some(value => value.pending)) throw new NativeRouteError("BUSY", "This IDE conversation already has an active request, including on another account.", 409);
    const revision = sha256(canonical(context));
    const uncertain = taskStates.filter(value => value.outcomeUnknown);
    const resolvingLegacy = rebind && !!explicitResumeUrl ? uncertain.filter(value => value.accountId === "default" && value.identityEpoch === 0 && (!value.resumeUrl || value.resumeUrl === explicitResumeUrl)) : [];
    if (uncertain.some(value => value !== state && !resolvingLegacy.includes(value)) || uncertain.length && !rebind) throw new NativeRouteError("OUTCOME_UNKNOWN", "This IDE conversation has an unresolved turn. Resume its original account and conversation before switching; no prompt was sent.", 409);
    if (!rebind && state?.outcomeUnknown) throw new NativeRouteError("OUTCOME_UNKNOWN", "A prior native turn may have reached Gemini Web. Select its exact conversation explicitly with native:resume before continuing; no prompt was sent.", 409);
    if (taskStates.some(value => !value.context && (value.revision === revision || value.pendingRevision === revision))) throw new NativeRouteError("OUTCOME_UNKNOWN", "This exact native context was already accepted before the proxy restarted. It will not be sent again.", 409);
    const staticPart = (value: NativeContext) => ({ ...value, contents: undefined });
    const previous = state?.context;
    const canResume = !rebind && !!previous && !!state?.revision;
    const canRebindRetained = !rebind && !previous && !!state?.resumeUrl;
    const canAppend = canResume && canonical(staticPart(previous)) === canonical(staticPart(context))
      && context.contents.length >= previous.contents.length
      && previous.contents.every((record, index) => canonical(record) === canonical(context.contents[index]));
    let mode: NativeConversationPlan["mode"] = canResume ? canAppend ? "append" : "patch" : "full";
    let patches = mode === "patch" ? contextPatch(previous, context) : undefined;
    if (patches) {
      if (canonical(applyContextPatch(previous, patches)) !== canonical(context)) throw new NativeRouteError("CONTEXT_SYNC_FAILED", "Context update did not reconstruct the complete host context. Nothing was sent.", 409);
      if (JSON.stringify(patches).length >= JSON.stringify(context).length) { mode = "replace"; patches = undefined; }
    }
    const retiredKeys: string[] = [];
    if (!canResume && !canRebindRetained) {
      if (state) retiredKeys.push(state.key);
      if (!state && this.states.size >= MAX_PERSISTED_NATIVE_TASKS) throw new NativeRouteError("CONVERSATION_LIMIT", "The durable task ledger is full; no replay fences were removed and no browser prompt was sent.", 409);
      if ((!state || state.outcomeUnknown) && [...this.states.values()].filter(value => !value.outcomeUnknown && !value.retired).length >= this.capacity) {
        const idle = [...this.states].find(([, value]) => !value.pending && !value.outcomeUnknown && !value.retired);
        if (!idle) throw new NativeRouteError("BUSY", "All retained native conversations are active.", 409);
        retiredKeys.push(idle[1].key); this.states.delete(idle[0]);
      }
      state = { taskKey, accountId, identityEpoch, surface, key: "conv_" + sha256(bindingKey + randomUUID()), ...(rebind && explicitResumeUrl ? { resumeUrl: explicitResumeUrl } : {}) };
      this.states.set(bindingKey, state);
    }
    const reservation = randomUUID();
    state!.resolvesLegacyKeys = resolvingLegacy.map(value => value.key);
    state!.pending = reservation; state!.pendingRevision = revision; state!.updatedAt = new Date().toISOString();
    try { this.persist(); }
    catch { state!.pending = undefined; state!.pendingRevision = undefined; throw new NativeRouteError("CONVERSATION_CACHE_UNAVAILABLE", "Could not durably reserve the native turn; no browser request was started.", 503); }
    return { accountId, identityEpoch, surface, key: state!.key, reservation, revision, expectedRevision: state!.revision, ...(canResume ? { baseRevision: state!.revision } : {}), appendFrom: canAppend ? previous!.contents.length : 0, context: structuredClone(context), retiredKeys, mode, patches,
      ...((canRebindRetained || rebind && explicitResumeUrl) ? { resumeUrl: state!.resumeUrl } : {}) };
  }
  complete(plan: NativeConversationPlan, conversationUrl?: string) {
    const state = [...this.states.values()].find(value => value.key === plan.key);
    if (!state || state.accountId !== plan.accountId || state.identityEpoch !== plan.identityEpoch || state.surface !== plan.surface || state.pending !== plan.reservation || state.revision !== plan.expectedRevision || sha256(canonical(plan.context)) !== plan.revision) throw new NativeRouteError("STALE_AUTHORITY", "Native conversation ownership changed.", 409);
    if (conversationUrl !== undefined && !GEMINI_CONVERSATION_URL.test(conversationUrl)) throw new NativeRouteError("INVALID_CONVERSATION_URL", "Browser returned a non-canonical Gemini conversation URL.", 502);
    for (const legacyKey of state.resolvesLegacyKeys ?? []) {
      const legacy = [...this.states.values()].find(value => value.key === legacyKey && value.taskKey === state.taskKey && value.accountId === "default");
      if (legacy) {
        legacy.revision = legacy.pendingRevision ?? legacy.revision; legacy.pendingRevision = undefined; legacy.outcomeUnknown = false; legacy.context = undefined; legacy.retired = true; legacy.updatedAt = new Date().toISOString();
      }
    }
    state.resolvesLegacyKeys = undefined;
    state.context = structuredClone(plan.context); state.revision = plan.revision; state.resumeUrl = conversationUrl ?? plan.resumeUrl ?? state.resumeUrl; state.pending = undefined; state.pendingRevision = undefined; state.outcomeUnknown = false; state.updatedAt = new Date().toISOString();
    try { this.persist(); }
    catch {
      state.context = undefined; state.pendingRevision = plan.revision; state.outcomeUnknown = true;
      throw new NativeRouteError("CONVERSATION_CACHE_UNAVAILABLE", "The turn completed but its conversation checkpoint could not be saved. Further requests are fenced until explicit resume.", 503);
    }
  }
  /** Only before any browser operation: retain the last acknowledged snapshot. */
  discardUnsent(plan: NativeConversationPlan) {
    for (const [key, value] of this.states) if (value.key === plan.key && value.pending === plan.reservation) {
      if (value.context || value.resumeUrl) { value.pending = undefined; value.pendingRevision = undefined; value.outcomeUnknown = false; }
      else this.states.delete(key);
      this.persist();
    }
  }
  markOutcomeUnknown(plan: NativeConversationPlan) {
    for (const value of this.states.values()) if (value.key === plan.key && value.pending === plan.reservation) {
      value.context = undefined; value.pending = undefined; value.pendingRevision = plan.revision; value.outcomeUnknown = true; value.updatedAt = new Date().toISOString(); this.persist();
    }
  }
  /** Compatibility helper for isolated unit fixtures; production failures use the durable quarantine path. */
  invalidate(plan: NativeConversationPlan) { for (const [key, value] of this.states) if (value.key === plan.key && value.pending === plan.reservation) this.states.delete(key); }
}

/** Decode only a nonce-bound final JSON text field. Tool arguments are never streamed. */
export function nativePartialText(raw: string, nonce: string): string | undefined {
  const fence = String.fromCharCode(96).repeat(3);
  let text = raw.trimStart();
  if (text.startsWith(fence + "ag-native-response")) text = text.slice(fence.length + "ag-native-response".length).trimStart();
  const prefix = new RegExp('^\\{\\s*"nonce"\\s*:\\s*"' + nonce + '"\\s*,\\s*"type"\\s*:\\s*"final"\\s*,\\s*"text"\\s*:\\s*"');
  const match = prefix.exec(text);
  if (!match) return undefined;
  const source = text.slice(match[0].length);
  let encoded = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') break;
    if (char === "\\") {
      if (index + 1 >= source.length) break;
      if (source[index + 1] === "u") {
        if (index + 5 >= source.length) break;
        encoded += source.slice(index, index + 6); index += 5;
      } else { encoded += source.slice(index, index + 2); index++; }
    } else encoded += char;
  }
  try {
    const decoded: string = JSON.parse('"' + encoded + '"');
    return decoded.slice(0, validUnicodePrefix(decoded));
  } catch { return undefined; }
}

export function nativeTextFrame(text: string, requestId: string): JsonObject {
  return { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] }, traceId: requestId };
}
