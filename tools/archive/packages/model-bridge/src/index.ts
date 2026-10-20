import { z } from "zod";
import type { UiError } from "@antigravity-gemini-web/contracts";

export const SafeToolNameSchema = z.enum(["read_file", "list_dir", "patch_file", "run_test"]);
export type SafeToolName = z.infer<typeof SafeToolNameSchema>;

export const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
}).strict();

export const ListDirArgsSchema = z.object({
  path: z.string().min(1).optional(),
}).strict();

export const PatchFileArgsSchema = z.object({
  path: z.string().min(1),
  patch: z.string().min(1),
}).strict();

export const RunTestArgsSchema = z.object({
  command: z.string().min(1).optional(),
  testName: z.string().optional(),
}).strict();

export const ToolCallEnvelopeSchema = z.object({
  schemaVersion: z.literal("0.1"),
  callId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  requestNonce: z.string().min(1),
  tool: SafeToolNameSchema,
  args: z.record(z.string(), z.unknown()),
}).strict();

export type ToolCallEnvelope = z.infer<typeof ToolCallEnvelopeSchema>;

export interface ExpectedBinding {
  sessionId?: string;
  turnId?: string;
  requestNonce?: string;
}

export interface ExecutionBinding {
  sessionId: string;
  turnId: string;
  requestNonce: string;
  allowedTools: ReadonlySet<string> | readonly string[] | string[];
  executedCallIds?: Set<string>;
}

export class EnvelopeParser {
  private static readonly MAX_ENVELOPE_CHARS = 65536;

  /**
   * Inspect text for syntactically valid antigravity-tool blocks without checking execution authority.
   * STRICT: ONLY specifically designated ```antigravity-tool blocks are accepted.
   * Generic ```json or standard code blocks (python, sh, js) are strictly ignored.
   */
  static inspectSyntax(text: string): ToolCallEnvelope | null {
    if (text.length > this.MAX_ENVELOPE_CHARS) {
      const error: UiError = {
        code: "CONTEXT_TOO_LARGE",
        message: `Response exceeds maximum allowed envelope size of ${this.MAX_ENVELOPE_CHARS} chars.`,
        retryable: false,
      };
      throw error;
    }

    const envelopePattern = /```antigravity-tool\s*\n([\s\S]*?)\n```/g;
    const matches: ToolCallEnvelope[] = [];

    let match: RegExpExecArray | null;
    while ((match = envelopePattern.exec(text)) !== null) {
      const rawJson = match[1]?.trim();
      if (!rawJson) continue;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawJson);
      } catch {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: "Malformed JSON inside antigravity-tool envelope.",
          retryable: false,
        };
        throw error;
      }

      const envelopeResult = ToolCallEnvelopeSchema.safeParse(parsedJson);
      if (!envelopeResult.success) {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: `Tool envelope failed schema validation: ${envelopeResult.error.message}`,
          retryable: false,
        };
        throw error;
      }

      const envelope = envelopeResult.data;

      // Validate per-tool argument schema
      if (envelope.tool === "read_file") {
        const argsResult = ReadFileArgsSchema.safeParse(envelope.args);
        if (!argsResult.success) {
          const error: UiError = {
            code: "TOOL_DENIED",
            message: `Invalid arguments for read_file: ${argsResult.error.message}`,
            retryable: false,
          };
          throw error;
        }
      } else if (envelope.tool === "list_dir") {
        const argsResult = ListDirArgsSchema.safeParse(envelope.args);
        if (!argsResult.success) {
          const error: UiError = {
            code: "TOOL_DENIED",
            message: `Invalid arguments for list_dir: ${argsResult.error.message}`,
            retryable: false,
          };
          throw error;
        }
      } else if (envelope.tool === "patch_file") {
        const argsResult = PatchFileArgsSchema.safeParse(envelope.args);
        if (!argsResult.success) {
          const error: UiError = {
            code: "TOOL_DENIED",
            message: `Invalid arguments for patch_file: ${argsResult.error.message}`,
            retryable: false,
          };
          throw error;
        }
      } else if (envelope.tool === "run_test") {
        const argsResult = RunTestArgsSchema.safeParse(envelope.args);
        if (!argsResult.success) {
          const error: UiError = {
            code: "TOOL_DENIED",
            message: `Invalid arguments for run_test: ${argsResult.error.message}`,
            retryable: false,
          };
          throw error;
        }
      }

      matches.push(envelope);
    }

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      const error: UiError = {
        code: "CONTRACT_MISMATCH",
        message: "Ambiguous tool envelopes: multiple tool calls found in a single response turn.",
        retryable: false,
      };
      throw error;
    }

    return matches[0] ?? null;
  }

  /**
   * Parse structured tool call envelopes with mandatory execution authority binding and host tool inventory (R7).
   * MUST be used on execution paths before any IDE tool action is dispatched.
   */
  static parseForExecution(text: string, binding: ExecutionBinding): ToolCallEnvelope | null {
    if (!binding || !binding.sessionId || !binding.turnId || !binding.requestNonce) {
      const error: UiError = {
        code: "CONTRACT_MISMATCH",
        message: "Execution binding requires non-empty sessionId, turnId, and requestNonce.",
        retryable: false,
      };
      throw error;
    }

    const envelope = this.inspectSyntax(text);
    if (!envelope) return null;

    // 1. Enforce strict authority binding
    if (envelope.sessionId !== binding.sessionId) {
      const error: UiError = {
        code: "CONTRACT_MISMATCH",
        message: `Stale session binding: envelope has sessionId '${envelope.sessionId}', expected '${binding.sessionId}'.`,
        retryable: false,
      };
      throw error;
    }
    if (envelope.turnId !== binding.turnId) {
      const error: UiError = {
        code: "CONTRACT_MISMATCH",
        message: `Stale turn binding: envelope has turnId '${envelope.turnId}', expected '${binding.turnId}'.`,
        retryable: false,
      };
      throw error;
    }
    if (envelope.requestNonce !== binding.requestNonce) {
      const error: UiError = {
        code: "CONTRACT_MISMATCH",
        message: `Invalid request nonce: envelope has '${envelope.requestNonce}', expected '${binding.requestNonce}'.`,
        retryable: false,
      };
      throw error;
    }

    // 2. Enforce host tool inventory
    const allowed = binding.allowedTools instanceof Set
      ? binding.allowedTools
      : new Set(binding.allowedTools);

    if (!allowed.has(envelope.tool)) {
      const error: UiError = {
        code: "TOOL_DENIED",
        message: `Tool '${envelope.tool}' is not in host tool inventory for current turn.`,
        retryable: false,
      };
      throw error;
    }

    // 3. Enforce call ID ledger / deduplication
    if (binding.executedCallIds) {
      if (binding.executedCallIds.has(envelope.callId)) {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: `Duplicate tool call ID '${envelope.callId}': call has already been executed.`,
          retryable: false,
        };
        throw error;
      }
      binding.executedCallIds.add(envelope.callId);
    }

    return envelope;
  }

  /**
   * Compatibility parse method with optional binding.
   */
  static parse(text: string, expectedBinding?: ExpectedBinding): ToolCallEnvelope | null {
    const envelope = this.inspectSyntax(text);
    if (!envelope) return null;

    if (expectedBinding) {
      if (expectedBinding.sessionId && envelope.sessionId !== expectedBinding.sessionId) {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: `Stale session binding: envelope has sessionId '${envelope.sessionId}', expected '${expectedBinding.sessionId}'.`,
          retryable: false,
        };
        throw error;
      }
      if (expectedBinding.turnId && envelope.turnId !== expectedBinding.turnId) {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: `Stale turn binding: envelope has turnId '${envelope.turnId}', expected '${expectedBinding.turnId}'.`,
          retryable: false,
        };
        throw error;
      }
      if (expectedBinding.requestNonce && envelope.requestNonce !== expectedBinding.requestNonce) {
        const error: UiError = {
          code: "CONTRACT_MISMATCH",
          message: `Invalid request nonce: envelope has '${envelope.requestNonce}', expected '${expectedBinding.requestNonce}'.`,
          retryable: false,
        };
        throw error;
      }
    }

    return envelope;
  }
}

export interface ModelBridge {
  routeInference(turnId: string, prompt: string): Promise<never>;
}

export class LiveModelBridgeStub implements ModelBridge {
  async routeInference(turnId: string, prompt: string): Promise<never> {
    const error: UiError = {
      code: "NATIVE_ROUTE_UNVERIFIED",
      message: "Native inference protocol is unverified; inference routing is unavailable.",
      retryable: false,
    };
    throw error;
  }
}
