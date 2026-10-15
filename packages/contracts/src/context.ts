import { z } from "zod";

export const ContextMessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ContextMessageRole = z.infer<typeof ContextMessageRoleSchema>;

export const ContextMessageSchema = z.object({
  role: ContextMessageRoleSchema,
  content: z.string(),
  author: z.string().optional(),
  toolCallId: z.string().optional(),
  timestamp: z.string().optional(),
}).strict();
export type ContextMessage = z.infer<typeof ContextMessageSchema>;

export const ToolResultRecordSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  output: z.string(),
  isError: z.boolean().default(false),
  executedAt: z.string().optional(),
}).strict();
export type ToolResultRecord = z.infer<typeof ToolResultRecordSchema>;

export const ModelContextMetadataSchema = z.object({
  modelId: z.string().optional(),
  knownContextLimit: z.number().int().positive().optional(),
  isEstimate: z.boolean().default(true),
  notes: z.string().optional(),
}).strict();
export type ModelContextMetadata = z.infer<typeof ModelContextMetadataSchema>;

export const StructuredContextSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().optional(),
  instructions: z.string().default(""),
  history: z.array(ContextMessageSchema).default([]),
  toolResults: z.array(ToolResultRecordSchema).default([]),
  modelMetadata: ModelContextMetadataSchema.optional(),
}).strict();
export type StructuredContext = z.infer<typeof StructuredContextSchema>;

export const ContextMetricsSchema = z.object({
  byteCount: z.number().int().nonnegative(),
  characterCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  isEstimate: z.literal(true),
  withinLimit: z.boolean(),
  safetyCap: z.number().int().positive(),
  modelLimit: z.number().int().positive().optional(),
}).strict();
export type ContextMetrics = z.infer<typeof ContextMetricsSchema>;

