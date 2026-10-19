import { z } from "zod";

export const UiErrorCodeSchema = z.enum([
  "HOST_NOT_FOUND",
  "NATIVE_ROUTE_UNVERIFIED",
  "NATIVE_ROUTE_UNSUPPORTED",
  "NATIVE_RUNTIME_UPDATE_REQUIRED",
  "OWNER_MISMATCH",
  "CONFIG_CONFLICT",
  "LOGIN_REQUIRED",
  "BROWSER_USER_ACTION_REQUIRED",
  "MODEL_UNAVAILABLE",
  "MODEL_RESTORE_PENDING",
  "BROWSER_UI_CHANGED",
  "CONTEXT_TOO_LARGE",
  "TURN_TIMEOUT",
  "TOOL_DENIED",
  "OUTCOME_UNKNOWN",
  "RUNTIME_DISCONNECTED",
  "CONTRACT_MISMATCH",
  "WORKSPACE_MISMATCH",
  "QUEUE_FULL",
  "RESOURCE_LIMIT",
  "MUTATION_UNKNOWN",
  "STALE_AUTHORITY",
  "REBIND_REQUIRED",
  "UNSUPPORTED_OPERATION",
  "SERVICE_UNAVAILABLE",
  "BUSY",
  "CANCELLED",
  "ACCOUNT_IDENTITY_CHANGED",
  "ACCOUNT_SELECTED",
  "ACCOUNT_IN_USE",
  "ACCOUNT_BOUND",
  "LAST_ACCOUNT",
  "CONVERSATION_NOT_OPEN",
  "CONVERSATION_NOT_ACCESSIBLE",
  "CONVERSATION_CHANGED",
  "SOURCE_NOT_READY",
  "SOURCE_EXPERIMENT_DISABLED",
  "SOURCE_STILL_BOUND",
  "SOURCE_STALE",
  "SOURCE_OVERLAY_REQUIRED",
  "SOURCE_FILE_EXCLUDED",
  "SOURCE_PATH_UNSAFE",
  "SOURCE_CREDENTIAL_CONTENT",
  "SOURCE_NOT_TEXT",
  "SOURCE_FILE_TOO_LARGE",
  "SOURCE_SELECTION_INVALID",
  "SOURCE_REGISTRY_UNAVAILABLE",
]);

export type UiErrorCode = z.infer<typeof UiErrorCodeSchema>;

export const SuggestedActionSchema = z.enum([
  "open_browser",
  "run_check",
  "review_integration",
  "view_activity",
  "switch_account",
  "reopen_conversation",
]);

export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

// Static control states only: never attach DOM text, prompts or credentials.
export const ModelSelectionDiagnosticSchema = z.object({
  stage: z.enum(["open_model", "choose_model", "verify_model", "open_effort", "choose_effort", "verify_effort", "close_menu"]),
  verificationOnly: z.boolean(),
}).strict();
export type ModelSelectionDiagnostic = z.infer<typeof ModelSelectionDiagnosticSchema>;

export const UiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  suggestedAction: SuggestedActionSchema.optional(),
  correlationId: z.string().optional(),
  detail: z.string().max(512).optional(),
  modelSelection: ModelSelectionDiagnosticSchema.optional(),
});

export type UiError = z.infer<typeof UiErrorSchema>;

