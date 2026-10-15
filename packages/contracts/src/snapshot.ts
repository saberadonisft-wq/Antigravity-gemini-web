import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";
import { UiErrorSchema } from "./errors.js";
import { CapabilityMapSchema } from "./capabilities.js";
import { ModelInfoSchema } from "./models.js";
import { SessionSummarySchema } from "./sessions.js";
import { SettingsSchema } from "./settings.js";
import { CheckResultSchema } from "./checks.js";

export const RuntimeStateSchema = z.enum([
  "stopped",
  "starting",
  "ready",
  "degraded",
  "stopping",
  "failed",
]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const BrowserStateSchema = z.enum([
  "closed",
  "opening",
  "ready",
  "needs_user_action",
  "failed",
]);
export type BrowserState = z.infer<typeof BrowserStateSchema>;

export const AccountStateSchema = z.enum([
  "unknown",
  "signed_out",
  "checking",
  "signed_in",
  "needs_user_action",
]);
export type AccountState = z.infer<typeof AccountStateSchema>;

export const IntegrationStateSchema = z.enum([
  "unverified",
  "unsupported",
  "not_installed",
  "installing",
  "connected",
  "disconnected",
  "conflict",
  "failed",
]);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const RuntimeSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  lastEventSequence: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
  mode: z.enum(["demo", "live"]),
  runtime: z.object({
    state: RuntimeStateSchema,
    version: z.string().optional(),
    error: UiErrorSchema.optional(),
  }),
  browser: z.object({
    state: BrowserStateSchema,
    actionReason: z.string().optional(),
    error: UiErrorSchema.optional(),
  }),
  account: z.object({
    state: AccountStateSchema,
    displayLabel: z.string().optional(),
    checkedAt: z.string().datetime().optional(),
  }),
  integration: z.object({
    target: z.literal("native_ide"),
    state: IntegrationStateSchema,
    hostVersion: z.string().optional(),
    checkedAt: z.string().datetime().optional(),
    error: UiErrorSchema.optional(),
  }),
  capabilities: CapabilityMapSchema,
  availableModels: z.array(ModelInfoSchema),
  selectedModelId: z.string().nullable(),
  sessions: z.array(SessionSummarySchema),
  settings: SettingsSchema,
  lastCheck: z
    .object({
      operationId: z.string().min(1),
      at: z.string().datetime(),
      checks: z.array(CheckResultSchema),
    })
    .nullable(),
});

export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

