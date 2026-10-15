import { z } from "zod";
import { UiErrorSchema } from "./errors.js";
import { CommandTypeSchema, type CommandType } from "./commands.js";
import { CheckResultSchema } from "./checks.js";

export const OperationStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
]);

export type OperationState = z.infer<typeof OperationStateSchema>;

export const TERMINAL_OPERATION_STATES: ReadonlySet<OperationState> = new Set([
  "succeeded",
  "failed",
  "outcome_unknown",
]);

export function isTerminalOperationState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.has(state);
}

export const IntegrationPreviewResultSchema = z.object({
  previewId: z.string().min(1),
  action: z.string().min(1),
  summary: z.string().min(1),
  canApply: z.boolean(),
}).strict();

export type IntegrationPreviewResult = z.infer<typeof IntegrationPreviewResultSchema>;

export const RuntimeCheckResultSchema = z.object({
  checks: z.array(CheckResultSchema),
}).strict();

export type RuntimeCheckResult = z.infer<typeof RuntimeCheckResultSchema>;

export const ActivityExportResultSchema = z.object({
  exportedCount: z.number().int().nonnegative(),
  sanitized: z.boolean(),
  redacted: z.boolean(),
}).strict();

export type ActivityExportResult = z.infer<typeof ActivityExportResultSchema>;

export const GenericSummaryResultSchema = z.object({
  summary: z.string().optional(),
  detail: z.string().optional(),
}).strict();

export type GenericSummaryResult = z.infer<typeof GenericSummaryResultSchema>;

export const OperationResultSchema = z.union([
  IntegrationPreviewResultSchema,
  RuntimeCheckResultSchema,
  ActivityExportResultSchema,
  GenericSummaryResultSchema,
]);

export type OperationResult = z.infer<typeof OperationResultSchema>;

export const OperationRecordBaseSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  type: CommandTypeSchema,
  state: OperationStateSchema,
  progressLabel: z.string().optional(),
  result: OperationResultSchema.optional(),
  error: UiErrorSchema.optional(),
  updatedAt: z.string().datetime(),
}).strict();

export const OperationRecordSchema = OperationRecordBaseSchema.superRefine((data, ctx) => {
  // If state is failed, error is mandatory and result must not be present
  if (data.state === "failed") {
    if (!data.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "Operation in 'failed' state must have an error object.",
      });
    }
    if (data.result !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Operation in 'failed' state must not have a result payload.",
      });
    }
  }

  // If state is succeeded, check type-specific result constraints
  if (data.state === "succeeded") {
    if (data.type === "integration.preview") {
      const parsed = IntegrationPreviewResultSchema.safeParse(data.result);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result"],
          message: "Operation 'integration.preview' in 'succeeded' state must have a valid IntegrationPreviewResult.",
        });
      }
    } else if (data.type === "runtime.check") {
      const parsed = RuntimeCheckResultSchema.safeParse(data.result);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result"],
          message: "Operation 'runtime.check' in 'succeeded' state must have a valid RuntimeCheckResult.",
        });
      }
    } else if (data.type === "activity.export") {
      const parsed = ActivityExportResultSchema.safeParse(data.result);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result"],
          message: "Operation 'activity.export' in 'succeeded' state must have a valid ActivityExportResult.",
        });
      }
    } else if (data.result !== undefined) {
      // Other commands (browser.open, turn.cancel, settings.update, account.check, etc.)
      // cannot accept previewId, checks, or exportCount
      if (
        IntegrationPreviewResultSchema.safeParse(data.result).success ||
        RuntimeCheckResultSchema.safeParse(data.result).success ||
        ActivityExportResultSchema.safeParse(data.result).success
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result"],
          message: `Operation '${data.type}' cannot accept result schema of preview, check, or export.`,
        });
      }
    }
  }
});

export type OperationRecord = z.infer<typeof OperationRecordBaseSchema>;

