import { z } from "zod";

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
