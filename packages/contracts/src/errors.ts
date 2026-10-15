import { z } from "zod";

export const UiErrorCodeSchema = z.enum([
  "HOST_NOT_FOUND",
  "NATIVE_ROUTE_UNVERIFIED",
  "NATIVE_ROUTE_UNSUPPORTED",
  "CONFIG_CONFLICT",
  "LOGIN_REQUIRED",
  "BROWSER_USER_ACTION_REQUIRED",
  "MODEL_UNAVAILABLE",
  "BROWSER_UI_CHANGED",
  "CONTEXT_TOO_LARGE",
  "TURN_TIMEOUT",
  "TOOL_DENIED",
  "OUTCOME_UNKNOWN",
  "RUNTIME_DISCONNECTED",
  "CONTRACT_MISMATCH",
  "WORKSPACE_MISMATCH",
  "QUEUE_FULL",
  "MUTATION_UNKNOWN",
  "STALE_AUTHORITY",
  "REBIND_REQUIRED",
  "UNSUPPORTED_OPERATION",
  "SERVICE_UNAVAILABLE",
  "BUSY",
  "CANCELLED",
]);

export type UiErrorCode = z.infer<typeof UiErrorCodeSchema>;

export const SuggestedActionSchema = z.enum([
  "open_browser",
  "run_check",
  "review_integration",
  "view_activity",
]);

export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export const UiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  suggestedAction: SuggestedActionSchema.optional(),
  correlationId: z.string().optional(),
});

export type UiError = z.infer<typeof UiErrorSchema>;

