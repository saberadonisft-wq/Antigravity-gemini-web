import { z } from "zod";
import { UiErrorSchema } from "./errors.js";
import { SettingsPatchSchema } from "./settings.js";

export const CommandTypeSchema = z.enum([
  "browser.open",
  "account.check",
  "runtime.check",
  "integration.preview",
  "integration.apply",
  "model.select",
  "turn.cancel",
  "settings.update",
  "activity.export",
]);

export type CommandType = z.infer<typeof CommandTypeSchema>;

export const BrowserOpenCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("browser.open"),
  payload: z.object({}).strict(),
}).strict();

export const AccountCheckCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("account.check"),
  payload: z.object({}).strict(),
}).strict();

export const RuntimeCheckCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("runtime.check"),
  payload: z.object({
    scope: z.enum(["connection", "end_to_end"]),
  }).strict(),
}).strict();

export const IntegrationPreviewCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("integration.preview"),
  payload: z.object({
    action: z.enum(["install", "disconnect", "restore"]),
  }).strict(),
}).strict();

export const IntegrationApplyCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("integration.apply"),
  payload: z.object({
    previewId: z.string().min(1),
  }).strict(),
}).strict();

export const ModelSelectCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("model.select"),
  payload: z.object({
    modelId: z.string().min(1),
  }).strict(),
}).strict();

export const TurnCancelCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("turn.cancel"),
  payload: z.object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
  }).strict(),
}).strict();

export const SettingsUpdateCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("settings.update"),
  payload: z.object({
    expectedRevision: z.number().int().nonnegative(),
    patch: SettingsPatchSchema,
  }).strict(),
}).strict();

export const ActivityExportCommandSchema = z.object({
  requestId: z.string().min(1),
  type: z.literal("activity.export"),
  payload: z.object({
    range: z.enum(["current_session", "last_24h"]),
  }).strict(),
}).strict();

export const ControlCommandSchema = z.discriminatedUnion("type", [
  BrowserOpenCommandSchema,
  AccountCheckCommandSchema,
  RuntimeCheckCommandSchema,
  IntegrationPreviewCommandSchema,
  IntegrationApplyCommandSchema,
  ModelSelectCommandSchema,
  TurnCancelCommandSchema,
  SettingsUpdateCommandSchema,
  ActivityExportCommandSchema,
]);

export type ControlCommand = z.infer<typeof ControlCommandSchema>;

export const CommandAckAcceptedSchema = z.object({
  requestId: z.string().min(1),
  accepted: z.literal(true),
  operationId: z.string().min(1),
}).strict();

export const CommandAckRejectedSchema = z.object({
  requestId: z.string().min(1),
  accepted: z.literal(false),
  error: UiErrorSchema,
}).strict();

export const CommandAckSchema = z.discriminatedUnion("accepted", [
  CommandAckAcceptedSchema,
  CommandAckRejectedSchema,
]);

export type CommandAck = z.infer<typeof CommandAckSchema>;
export type CommandAckAccepted = z.infer<typeof CommandAckAcceptedSchema>;
export type CommandAckRejected = z.infer<typeof CommandAckRejectedSchema>;
