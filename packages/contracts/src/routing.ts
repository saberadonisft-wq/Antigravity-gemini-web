import { z } from "zod";

const AccountId=z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/);
const TaskScope=z.string().regex(/^[a-f0-9]{64}$/);
export const NativeFailoverSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  maxAttempts:z.number().int().min(2).max(4).default(2),
  deadlineMs:z.number().int().min(1000).max(120000).default(60000),
}).strict();
export type NativeFailoverSettings=z.infer<typeof NativeFailoverSettingsSchema>;
export const NativeRoutingSettingsSchema=z.object({
  mode:z.enum(["manual","sticky","priority","round_robin"]).default("manual"),
  priority:z.array(AccountId).max(32).default([]),
  modelSelection:z.object({model:z.string().min(1).max(100),effort:z.string().min(1).max(60).optional()}).strict().optional(),
  roundRobinOptIn:z.boolean().default(false),
  failover:NativeFailoverSettingsSchema.optional(),
}).strict().superRefine((value,context)=>{
  if(new Set(value.priority).size!==value.priority.length)context.addIssue({code:z.ZodIssueCode.custom,path:["priority"],message:"Account priority contains duplicates."});
  if(value.mode!=="manual"&&!value.modelSelection)context.addIssue({code:z.ZodIssueCode.custom,path:["modelSelection"],message:"Automatic routing requires one explicit Web model/effort policy."});
  if(value.mode==="round_robin"&&!value.roundRobinOptIn)context.addIssue({code:z.ZodIssueCode.custom,path:["roundRobinOptIn"],message:"Round robin requires explicit opt-in."});
  if(value.failover?.enabled&&value.mode==="manual")context.addIssue({code:z.ZodIssueCode.custom,path:["failover"],message:"Failover requires an explicit automatic routing mode and fixed model policy."});
});
export type NativeRoutingSettings=z.infer<typeof NativeRoutingSettingsSchema>;
export const NativeRoutingFileSchema=z.object({
  version:z.literal(1),revision:z.number().int().nonnegative(),settings:NativeRoutingSettingsSchema,
  cursor:z.number().int().nonnegative(),
  bindings:z.array(z.object({taskScope:TaskScope,accountId:AccountId,identityEpoch:z.number().int().nonnegative(),updatedAt:z.string().datetime()}).strict()).max(4096),
}).strict();
export type NativeRoutingFile=z.infer<typeof NativeRoutingFileSchema>;
export const NativeRoutingControlSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("status")}).strict(),
  z.object({action:z.literal("configure"),expectedRevision:z.number().int().nonnegative(),settings:NativeRoutingSettingsSchema}).strict(),
  z.object({action:z.literal("unbind"),expectedRevision:z.number().int().nonnegative(),taskScope:TaskScope}).strict(),
]);
