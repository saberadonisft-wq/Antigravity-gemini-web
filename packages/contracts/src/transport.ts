import { z } from "zod";

export const WebModelSelectionSchema = z.object({ model: z.string().min(1).max(100), effort: z.string().min(1).max(60).optional() }).strict();

/** Content-only wire format. Callers cannot name a local file or directory. */
export const NativeSnapshotAttachmentSchema = z.object({
  version: z.literal(1), mediaType: z.literal("text/plain"),
  fileName: z.string().regex(/^ag-native-context-[a-f0-9]{64}\.txt$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1).max(262144).refine(value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "Snapshot must contain valid Unicode scalar values."),
}).strict().superRefine((value, context) => {
  if (value.fileName !== `ag-native-context-${value.sha256}.txt`) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fileName"], message: "Snapshot filename must match its digest." });
});
export type NativeSnapshotAttachment = z.infer<typeof NativeSnapshotAttachmentSchema>;

/** Correlation metadata, never prompt/tool payloads or credentials. */
export const NativeReceiptOwnerSchema = z.object({
  logicalRequestId: z.string().regex(/^native_[a-f0-9]{64}$/),
  logicalAttemptId: z.string().uuid(), accountId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/),
  identityEpoch: z.number().int().nonnegative(),
}).strict();
export type NativeReceiptOwner = z.infer<typeof NativeReceiptOwnerSchema>;
export const PhysicalReceiptMetadataSchema = z.object({
  requestId:z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/), hash:z.string().regex(/^[a-f0-9]{64}$/),
  phase:z.enum(["reserved","accepted","terminal"]), attemptId:z.string().uuid(),
  createdAt:z.string().datetime(), updatedAt:z.string().datetime(), owner:NativeReceiptOwnerSchema.optional(),
}).strict();
export const NativeLogicalReceiptQuerySchema=z.object({requestId:z.string().regex(/^native_[a-f0-9]{64}$/)}).strict();
export const PhysicalReceiptInspectionSchema=z.object({
  requestId:z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/),found:z.boolean(),receipt:PhysicalReceiptMetadataSchema.optional(),
  replayAllowed:z.literal(false),resultAvailable:z.boolean(),
}).strict().superRefine((value,context)=>{
  if(value.found!==!!value.receipt||(value.receipt&&value.receipt.requestId!==value.requestId))context.addIssue({code:z.ZodIssueCode.custom,message:"Physical receipt identity is inconsistent."});
});

// Structural diagnostics only: never DOM text, file paths, prompts or cookies.
export const BrowserSubmissionDiagnosticSchema = z.object({
  inputChars: z.number().int().min(0).max(262144),
  readbackVerified: z.boolean(), sendClickAttempted: z.boolean(), acceptanceObserved: z.boolean(),
}).strict();
export type BrowserSubmissionDiagnostic = z.infer<typeof BrowserSubmissionDiagnosticSchema>;

export const NativeTransportTraceSchema = z.object({
  messageIndex: z.number().int().min(1).max(11), messageCount: z.number().int().min(1).max(11),
  kind: z.enum(["text", "fragment", "commit", "attachment"]), stage: z.enum(["prepared", "completed", "failed"]),
  promptChars: z.number().int().min(0).max(28000), promptBytes: z.number().int().min(0).max(112000),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/), elapsedMs: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative().max(131072).optional(), responseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ackMatches: z.boolean().optional(), code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
  responseCategory: z.enum(["ack", "known_error_text", "unexpected_ack", "native_envelope", "other"]).optional(),
  submission: BrowserSubmissionDiagnosticSchema.optional(),
  modelSelection: WebModelSelectionSchema.optional(), restoredModel: WebModelSelectionSchema.optional(),
  attachment: z.object({ chars: z.number().int().min(1).max(262144), utf8Bytes: z.number().int().min(1).max(1048576), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type NativeTransportTrace = z.infer<typeof NativeTransportTraceSchema>;
