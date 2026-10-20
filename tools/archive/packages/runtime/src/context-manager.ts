import crypto from "node:crypto";
import path from "node:path";
import { StructuredContextSchema, type StructuredContext, type ContextMetrics, type UiError } from "@antigravity-gemini-web/contracts";
import { canonicalJson } from "./fingerprinting.js";

export interface ContextManagerOptions {
  localSafetyCapTokens?: number;
  maxByteSize?: number;
}

/** Opaque IDs are case sensitive. Only absolute Windows paths have path semantics. */
export function canonicalWorkspaceId(id: string): string {
  if (!id || !id.trim()) throw { code: "CONTRACT_MISMATCH", message: "Workspace identity is required.", retryable: false } satisfies UiError;
  if (/^[a-z]:[\\/]/i.test(id) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(id)) {
    const normalized = path.win32.normalize(id).toLowerCase();
    return normalized === path.win32.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, "");
  }
  return id;
}

export class ContextManager {
  public readonly localSafetyCapTokens: number;
  public readonly maxByteSize: number;

  constructor(options: ContextManagerOptions = {}) {
    this.localSafetyCapTokens = options.localSafetyCapTokens ?? 32_000;
    this.maxByteSize = options.maxByteSize ?? 1_000_000;
    for (const limit of [this.localSafetyCapTokens, this.maxByteSize]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Context limits must be positive finite integers.");
    }
  }

  private parse(context: StructuredContext): StructuredContext {
    const result = StructuredContextSchema.safeParse(context);
    if (!result.success) throw { code: "CONTRACT_MISMATCH", message: "Invalid structured context.", retryable: false } satisfies UiError;
    return result.data;
  }

  public validateWorkspace(context: StructuredContext, expectedWorkspaceId: string): void {
    if (canonicalWorkspaceId(context.workspaceId) !== canonicalWorkspaceId(expectedWorkspaceId)) {
      throw { code: "WORKSPACE_MISMATCH", message: "Context belongs to a different workspace.", retryable: false } satisfies UiError;
    }
  }

  public validateBinding(context: StructuredContext, workspaceId: string, sessionId: string): void {
    const parsed = this.parse(context);
    this.validateWorkspace(parsed, workspaceId);
    if (parsed.sessionId !== sessionId) throw { code: "STALE_AUTHORITY", message: "Context belongs to a different session.", retryable: false } satisfies UiError;
  }

  /** Includes the full serialized envelope, including metadata and tool outputs. */
  public evaluateMetrics(context: StructuredContext): ContextMetrics {
    const parsed = this.parse(context);
    const serialized = canonicalJson(parsed);
    const byteCount = Buffer.byteLength(serialized, "utf8");
    const characterCount = serialized.length;
    const estimatedTokens = Math.ceil(Math.max(characterCount, byteCount) / 4);
    const modelLimit = parsed.modelMetadata?.knownContextLimit;
    const effectiveLimit = Math.min(modelLimit ?? this.localSafetyCapTokens, this.localSafetyCapTokens);
    return {
      byteCount, characterCount, estimatedTokens, isEstimate: true,
      withinLimit: estimatedTokens <= effectiveLimit && byteCount <= this.maxByteSize,
      safetyCap: this.localSafetyCapTokens, modelLimit,
    };
  }

  public assertWithinBudget(context: StructuredContext, expectedWorkspaceId?: string, expectedSessionId?: string): ContextMetrics {
    if (expectedWorkspaceId !== undefined) this.validateWorkspace(context, expectedWorkspaceId);
    if (expectedSessionId !== undefined && context.sessionId !== expectedSessionId) {
      throw { code: "STALE_AUTHORITY", message: "Context belongs to a different session.", retryable: false } satisfies UiError;
    }
    const metrics = this.evaluateMetrics(context);
    if (!metrics.withinLimit) throw {
      code: "CONTEXT_TOO_LARGE",
      message: `Context (${metrics.estimatedTokens} estimated tokens, ${metrics.byteCount} bytes) exceeds local safety cap or declared model limit. Silent dropping is disallowed.`,
      retryable: false,
    } satisfies UiError;
    return metrics;
  }

  public compact(_context: StructuredContext): never {
    throw { code: "UNSUPPORTED_OPERATION", message: "Host compaction protocol is unverified. Silent dropping of history/instructions is forbidden.", retryable: false, suggestedAction: "review_integration" } satisfies UiError;
  }

  public verifyModelBinding(context: StructuredContext, currentModelId: string | null): void {
    const requested = this.parse(context).modelMetadata?.modelId;
    if (requested && requested !== currentModelId) {
      throw { code: "REBIND_REQUIRED", message: "Requested model does not match a verified active model.", retryable: true } satisfies UiError;
    }
  }

  public fingerprint(context: StructuredContext): string {
    return crypto.createHash("sha256").update(canonicalJson(this.parse(context))).digest("hex");
  }
}
