import { z } from "zod";
const AccountId = z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/);

export const CHAT_IMPORT_MAX_ARCHIVE_BYTES = 5_000_000_000;
export const CHAT_IMPORT_MAX_ENTRIES = 1_000_000;
export const ChatImportProviderSchema = z.enum(["chatgpt", "claude"]);
export type ChatImportProvider = z.infer<typeof ChatImportProviderSchema>;
const ByteCount = z.string().regex(/^(?:0|[1-9][0-9]{0,23})$/);
export const ChatImportInspectionSchema = z.object({
  version: z.literal(1), declaredProvider: ChatImportProviderSchema,
  fileName: z.string().min(1).max(255).regex(/^[^/\\:\x00-\x1f\x7f]+\.zip$/i), bytes: z.number().int().min(22).max(CHAT_IMPORT_MAX_ARCHIVE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: z.string().datetime(),
  directory: z.object({
    entries: z.number().int().min(1).max(CHAT_IMPORT_MAX_ENTRIES),
    files: z.number().int().min(1).max(CHAT_IMPORT_MAX_ENTRIES),
    folders: z.number().int().min(0).max(CHAT_IMPORT_MAX_ENTRIES),
    encryptedFiles: z.number().int().min(0).max(CHAT_IMPORT_MAX_ENTRIES),
    compressedBytes: ByteCount, uncompressedBytes: ByteCount,
  }).strict(),
  inspection: z.literal("directory_metadata_only"), contentsCrcVerified: z.literal(false),
  googleSubmission: z.literal("not_submitted"), googleCompatibility: z.literal("requires_live_validation"),
}).strict().superRefine((value, context) => {
  if (value.directory.files + value.directory.folders !== value.directory.entries || value.directory.encryptedFiles > value.directory.files) context.addIssue({ code: z.ZodIssueCode.custom, message: "Archive counters are inconsistent." });
});
export type ChatImportInspection = z.infer<typeof ChatImportInspectionSchema>;

const ImportAuthority = { expectedOwnerId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), expectedAccountRevision: z.number().int().nonnegative(), accountId: AccountId, identityEpoch: z.number().int().nonnegative() };
export const ChatImportIntentSchema = z.object({ ...ImportAuthority, provider: ChatImportProviderSchema }).strict();
export type ChatImportIntent = z.infer<typeof ChatImportIntentSchema>;
export const ChatImportUiCommandSchema = z.object({ action: z.enum(["cancel", "clear"]), expectedOwnerId: z.string().uuid(), jobId: z.string().uuid() }).strict();
export type ChatImportUiCommand = z.infer<typeof ChatImportUiCommandSchema>;
export const ChatImportRequestSchema = z.union([
  z.object({ action: z.literal("status") }).strict(), ChatImportUiCommandSchema,
  ChatImportIntentSchema.extend({ action: z.literal("inspect"), file: z.string().min(1).max(4096) }).strict(),
]);
export const ChatImportJobSchema = z.object({
  jobId: z.string().uuid(), accountId: AccountId, identityEpoch: z.number().int().nonnegative(), declaredProvider: ChatImportProviderSchema,
  state: z.enum(["checking", "cancelling", "ready", "cancelled", "failed", "stale", "expired"]),
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  bytesRead: z.number().int().min(0).max(CHAT_IMPORT_MAX_ARCHIVE_BYTES), totalBytes: z.number().int().min(0).max(CHAT_IMPORT_MAX_ARCHIVE_BYTES),
  inspection: ChatImportInspectionSchema.optional(), errorCode: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
}).strict().superRefine((job, context) => {
  if (job.bytesRead > job.totalBytes || (job.state === "ready") !== !!job.inspection || job.inspection && job.inspection.declaredProvider !== job.declaredProvider) context.addIssue({ code: z.ZodIssueCode.custom, message: "Import inspection job is inconsistent." });
});
export type ChatImportJob = z.infer<typeof ChatImportJobSchema>;
export const ChatImportSnapshotSchema = z.object({
  service: z.literal("gemini-native-chat-import"), version: z.literal(1), ownerId: z.string().uuid(), revision: z.number().int().nonnegative(), accountRevision: z.number().int().nonnegative(),
  experimentalEnabled: z.boolean(), canInspect: z.boolean(), inspectionActive: z.boolean(), jobs: z.array(ChatImportJobSchema).max(8),
  googleSubmission: z.literal("not_submitted"),
}).strict();
export type ChatImportSnapshot = z.infer<typeof ChatImportSnapshotSchema>;
export interface NativeChatImportClient {
  getNativeChatImports(): Promise<ChatImportSnapshot>;
  inspectNativeChatImport(intent: ChatImportIntent): Promise<ChatImportSnapshot>;
  executeNativeChatImport(command: ChatImportUiCommand): Promise<ChatImportSnapshot>;
}
