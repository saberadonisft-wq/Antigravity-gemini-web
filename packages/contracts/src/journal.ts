import { z } from "zod";
import { TurnStateSchema, isTerminalTurnState } from "./sessions.js";
import { UiErrorCodeSchema } from "./errors.js";

export const JournalTerminalOutcomeSchema = z.object({
  status: z.enum(["completed", "cancelled", "cancel_confirmed", "failed", "interrupted", "outcome_unknown"]),
  completedAt: z.string().datetime(),
  errorCode: UiErrorCodeSchema.optional(),
}).strict();
export type JournalTerminalOutcome = z.infer<typeof JournalTerminalOutcomeSchema>;

export const JournalReceiptSchema = z.object({
  submittedAt: z.string().datetime(),
  deadlineMs: z.number().int().positive().optional(),
}).strict();
export type JournalReceipt = z.infer<typeof JournalReceiptSchema>;

export const JournalEntrySchema = z.object({
  version: z.literal(1).default(1),
  instanceId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  requestId: z.string().min(1),
  phase: TurnStateSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  timestamp: z.string().datetime(),
  receipt: JournalReceiptSchema.optional(),
  terminalOutcome: JournalTerminalOutcomeSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  if (isTerminalTurnState(entry.phase) ? entry.terminalOutcome?.status !== entry.phase : entry.terminalOutcome !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalOutcome"], message: "Terminal outcome must match the phase, and must be absent for nonterminal phases." });
  }
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

