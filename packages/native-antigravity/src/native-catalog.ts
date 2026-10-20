import fs from "node:fs";
import path from "node:path";
import {NativeRouteError,WEB_MODEL,object,type JsonObject} from "./native-protocol.js";
export const PROD = "https://cloudcode-pa.googleapis.com";
export const DAILY = "https://daily-cloudcode-pa.googleapis.com";
/**
 * The picker identifier is deliberately distinct from WEB_MODEL (the internal
 * bridge route) and from MODEL_PLACEHOLDER_M* (the IDE enum).  Antigravity
 * keeps picker IDs in its model sort/cache, while it serializes the enum in a
 * generation request.  Keeping them separate mirrors the native catalog
 * contract and avoids an external-looking route name being treated as a
 * Google model identifier.
 */
export const WEB_CATALOG_MODEL = "custom-antigravity-gemini-web";
export interface UpstreamResult { status: number; body: Buffer; contentType: string }
export type ControlTransport = (origin: string, route: string, body: Buffer, headers: Record<string, string>, signal: AbortSignal) => Promise<UpstreamResult>;
export const MAX_BODY = 2 * 1024 * 1024;
const MAX_CONTROL_RESPONSE = 8 * 1024 * 1024;
export const CONTROL_ROUTES = /^\/v1internal:(?:loadCodeAssist|onboardUser|fetchUserInfo|fetchAvailableModels|fetchCredits|retrieveUserQuota|retrieveUserQuotaSummary|fetchAdminControls|recordCodeAssistTelemetry|recordCodeAssistMetrics|fetchUserTier|fetchUserStatus|fetchMcpServerConfigs|listExperiments|fetchExperiments)$/;
const MODEL_PREFIX = "MODEL_PLACEHOLDER_M";

/**
 * Keep the health endpoint useful when an IDE build changes its catalog wire
 * shape.  This deliberately contains only public catalog identifiers and
 * model enum values: never prompts, account details, or credentials.
 */
export function catalogModelReferences(value: unknown): JsonObject {
  const references: JsonObject[] = [];
  if (!object(value)) return { collections: 0, references };
  let collections = 0;
  for (const collection of ["models", "availableModels", "available_models"]) {
    const entries = value[collection];
    if (!entries || typeof entries !== "object") continue;
    collections++;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!object(entry) || references.length >= 128) continue;
        const name = entry.name;
        const model = entry.model;
        if ((typeof name === "string" || typeof name === "number") && (typeof model === "string" || typeof model === "number")) {
          references.push({ collection, key: String(name), model: String(model) });
        }
      }
    } else {
      for (const [key, entry] of Object.entries(entries)) {
        if (!object(entry) || references.length >= 128) continue;
        const model = entry.model;
        if (typeof model === "string" || typeof model === "number") references.push({ collection, key, model: String(model) });
      }
    }
  }
  return { collections, references };
}

export function modelSelectors(value: unknown): JsonObject {
  if (!object(value)) return {};
  const selected: JsonObject = {};
  for (const key of ["model", "modelId", "model_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") selected[key] = String(candidate);
  }
  return selected;
}

export const controlTransport: ControlTransport = async (origin, route, body, headers, signal) => {
  const response = await fetch(new URL(route, origin), { method: "POST", headers, body: new Uint8Array(body), signal, redirect: "manual" });
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_CONTROL_RESPONSE) { await response.body.cancel().catch(() => {}); throw new NativeRouteError("UPSTREAM_TOO_LARGE", "Cloud Code metadata exceeds its limit.", 502); }
    chunks.push(Buffer.from(chunk));
  }
  return { status: response.status, body: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "application/json" };
};

/** Protocol/catalog shapes researched from antigravity-add-model; see THIRD_PARTY_NOTICES.md. */
export class NativeModelIdentity {
  private slot?: number;
  constructor(private readonly filename: string) {
    if (fs.existsSync(filename)) {
      const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!object(value) || value.version !== 1 || value.model !== WEB_MODEL || !Number.isInteger(value.slot) || Number(value.slot) < 0 || Number(value.slot) > 650) throw new NativeRouteError("INVALID_IDENTITY", "Native model identity state is invalid.", 503);
      this.slot = Number(value.slot);
    }
  }
  get symbol() { return this.slot === undefined ? undefined : MODEL_PREFIX + this.slot; }
  matches(value: unknown): boolean {
    return value === WEB_MODEL || value === "models/" + WEB_MODEL ||
      value === WEB_CATALOG_MODEL || value === "models/" + WEB_CATALOG_MODEL ||
      (this.slot !== undefined && (value === this.symbol || value === "models/" + this.symbol || value === this.slot + 1000));
  }
  merge(upstream: unknown): JsonObject {
    if (!object(upstream)) throw new NativeRouteError("INVALID_CATALOG", "Upstream model catalog is invalid.", 502);
    const used = new Set<number>();
    for (const key of ["models", "availableModels", "available_models"]) {
      const entries = upstream[key];
      if (!entries || typeof entries !== "object") continue;
      for (const [name, value] of Object.entries(entries)) if (
        name !== WEB_MODEL && name !== WEB_CATALOG_MODEL &&
        (!object(value) || (value.name !== "models/" + WEB_MODEL && value.name !== "models/" + WEB_CATALOG_MODEL))
      ) {
        if (!object(value)) continue;
        const model = value.model;
        const index = typeof model === "number" ? model - 1000 : typeof model === "string" && /^MODEL_PLACEHOLDER_M\d+$/.test(model) ? Number(model.slice(MODEL_PREFIX.length)) : -1;
        if (Number.isInteger(index) && index >= 0 && index <= 650) used.add(index);
      }
    }
    if (this.slot !== undefined && used.has(this.slot)) throw new NativeRouteError("MODEL_IDENTITY_CONFLICT", "A native model now occupies the saved Gemini Web identity. Refusing to reassign cached selections.", 503);
    if (this.slot === undefined) {
      let slot = 650;
      while (used.has(slot)) slot--;
      if (slot < 0) throw new NativeRouteError("MODEL_IDENTITY_CAPACITY", "No native model identity is available.", 503);
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
      fs.writeFileSync(this.filename, JSON.stringify({ version: 1, model: WEB_MODEL, slot }) + "\n", { flag: "wx", mode: 0o600 });
      this.slot = slot;
    }
    const capabilities = { displayName: "Gemini Web (Local)", supportsImages: false, supportsThinking: false, supportsVideo: false, supportedMimeTypes: { "text/plain": true } };
    // IDE 2.5.5 validates a 50k checkpoint + 40k reserve. This is a catalog compatibility floor,
    // NOT a measured Gemini Web context window; compileNativeTurn enforces the real local text cap.
    const entry = { ...capabilities, recommended: true, maxTokens: 100000, maxOutputTokens: 8192,
      tokenizerType: "LLAMA_WITH_SPECIAL", model: this.symbol, apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelProvider: "MODEL_PROVIDER_GOOGLE" };
    // The native checkpoint experiment must only be advertised when a model
    // has a verified checkpoint configuration.  Supplying a generic one makes
    // some IDE versions resolve an unrelated cached placeholder (for example
    // M36) before a user turn reaches this proxy.
    const listEntry = { ...capabilities, name: "models/" + WEB_CATALOG_MODEL, version: "1.0",
      description: "Uses the signed-in Gemini Web conversation in this local browser.",
      inputTokenLimit: 100000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "countTokens"] };
    const result = structuredClone(upstream);
    let merged = false;
    for (const key of ["models", "availableModels", "available_models"]) {
      if (Array.isArray(result[key])) {
        result[key] = [listEntry, ...result[key].filter((value: unknown) => !object(value) || (value.name !== "models/" + WEB_MODEL && value.name !== "models/" + WEB_CATALOG_MODEL))];
        merged = true;
      } else if (object(result[key])) {
        const collection = { ...result[key] };
        delete collection[WEB_MODEL];
        collection[WEB_CATALOG_MODEL] = entry;
        result[key] = collection;
        merged = true;
      }
    }
    if (!merged) throw new NativeRouteError("INVALID_CATALOG", "Upstream did not provide a recognized native model collection.", 502);
    const sorts = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
    let attached = false;
    result.agentModelSorts = sorts.map(sort => {
      if (!object(sort) || !Array.isArray(sort.groups)) return sort;
      return { ...sort, groups: sort.groups.map(group => {
        if (!object(group) || !Array.isArray(group.modelIds)) return group;
        attached = true;
        return { ...group, modelIds: [...new Set([...group.modelIds, WEB_CATALOG_MODEL])] };
      }) };
    });
    if (!attached) (result.agentModelSorts as unknown[]).push({ displayName: "Gemini Web", groups: [{ modelIds: [WEB_CATALOG_MODEL] }] });
    // Antigravity 2.5.5 builds the Agent's default model override from this
    // catalog key. Without it, the picker can display the custom model while
    // a new Agent turn still serializes the upstream default model enum.
    // Pin only the isolated IDE's default Agent model to our catalog entry;
    // the generation gate below still rejects every other selector.
    if (object(result.models) && object((result.models as JsonObject)[WEB_CATALOG_MODEL])) {
      result.defaultAgentModelId = WEB_CATALOG_MODEL;
    }
    return result;
  }
}
