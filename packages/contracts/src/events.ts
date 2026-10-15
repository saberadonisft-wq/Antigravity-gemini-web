import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";
import { OperationRecordSchema } from "./operations.js";
import { SessionSummarySchema } from "./sessions.js";
import { ActivityEntrySchema } from "./activity.js";

export const RuntimeEventTypeSchema = z.enum([
  "snapshot.updated",
  "operation.updated",
  "session.updated",
  "activity.appended",
  "runtime.disconnected",
]);

export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

export const SnapshotUpdatedEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.literal("snapshot.updated"),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  payload: z.object({
    snapshot: RuntimeSnapshotSchema,
  }).strict(),
}).strict();

export const OperationUpdatedEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.literal("operation.updated"),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  payload: z.object({
    operation: OperationRecordSchema,
  }).strict(),
}).strict();

export const SessionUpdatedEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.literal("session.updated"),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  payload: z.object({
    session: SessionSummarySchema,
  }).strict(),
}).strict();

export const ActivityAppendedEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.literal("activity.appended"),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  payload: z.object({
    entry: ActivityEntrySchema,
  }).strict(),
}).strict();

export const RuntimeDisconnectedEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtimeInstanceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.literal("runtime.disconnected"),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  payload: z.object({
    reason: z.string().optional(),
    at: z.string().datetime(),
  }).strict(),
}).strict();

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  SnapshotUpdatedEventSchema,
  OperationUpdatedEventSchema,
  SessionUpdatedEventSchema,
  ActivityAppendedEventSchema,
  RuntimeDisconnectedEventSchema,
]);

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
