import { z } from "zod";
import { UiErrorSchema } from "./errors.js";

export const TurnStateSchema = z.enum([
  "queued",
  "reserved",
  "preparing",
  "awaiting_user",
  "submitting",
  "accepted",
  "generating",
  "streaming",
  "tool_pending",
  "tool_running",
  "completed",
  "cancel_requested",
  "cancel_confirmed",
  "cancelled",
  "failed",
  "interrupted",
  "outcome_unknown",
]);

export type TurnState = z.infer<typeof TurnStateSchema>;

const terminalStates = [
  "completed",
  "cancel_confirmed",
  "cancelled",
  "failed",
  "interrupted",
  "outcome_unknown",
] as const;
export type TerminalTurnState = typeof terminalStates[number];
export const TERMINAL_TURN_STATES: ReadonlySet<TurnState> = new Set(terminalStates);

export function isTerminalTurnState(state: TurnState): state is TerminalTurnState {
  return (terminalStates as readonly string[]).includes(state);
}

const transitions: Partial<Record<TurnState, readonly TurnState[]>> = {
  queued: ["reserved", "cancelled"],
  reserved: ["preparing", "awaiting_user", "submitting", "cancel_requested", "cancelled", "cancel_confirmed"],
  preparing: ["awaiting_user", "submitting", "cancel_requested", "cancelled", "cancel_confirmed"],
  awaiting_user: ["preparing", "submitting", "cancel_requested", "cancelled", "cancel_confirmed"],
  submitting: ["accepted", "generating", "streaming", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  accepted: ["generating", "streaming", "tool_pending", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  generating: ["streaming", "tool_pending", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  streaming: ["generating", "tool_pending", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  tool_pending: ["tool_running", "generating", "streaming", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  tool_running: ["tool_pending", "generating", "streaming", "completed", "cancel_requested", "cancel_confirmed", "cancelled"],
  cancel_requested: ["cancel_confirmed", "cancelled", "completed"],
};

export function canTransitionTurnState(from: TurnState, to: TurnState): boolean {
  if (isTerminalTurnState(from)) return false;
  return from === to || ["failed", "interrupted", "outcome_unknown"].includes(to) || (transitions[from]?.includes(to) ?? false);
}

export const TurnSummarySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  state: TurnStateSchema,
  phaseLabel: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: UiErrorSchema.optional(),
  canCancel: z.boolean(),
});

export type TurnSummary = z.infer<typeof TurnSummarySchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  workspaceLabel: z.string().min(1),
  hostTaskId: z.string().optional(),
  modelId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activeTurn: TurnSummarySchema.optional(),
  lastOutcome: TurnStateSchema.optional(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

