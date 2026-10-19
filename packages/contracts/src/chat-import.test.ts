import test from "node:test";
import assert from "node:assert/strict";
import { ChatImportInspectionSchema, ChatImportProviderSchema } from "./chat-import.js";

test("Import inspection cannot claim upload, Google compatibility, account migration or contain local paths/content", () => {
  const result = { version: 1, declaredProvider: "chatgpt", fileName: "export.zip", bytes: 100, sha256: "a".repeat(64), checkedAt: new Date().toISOString(),
    directory: { entries: 1, files: 1, folders: 0, encryptedFiles: 0, compressedBytes: "10", uncompressedBytes: "90071992547409910" },
    inspection: "directory_metadata_only", contentsCrcVerified: false, googleSubmission: "not_submitted", googleCompatibility: "requires_live_validation" };
  assert.equal(ChatImportInspectionSchema.safeParse(result).success, true);
  for (const patch of [{ googleSubmission: "completed" }, { googleCompatibility: "verified" }, { contents: "private chat" }, { fileName: "C:\\private\\export.zip" }, { fileName: "../export.zip" }, { bytes: 5000000001 }, { directory: { ...result.directory, folders: 1 } }]) assert.equal(ChatImportInspectionSchema.safeParse({ ...result, ...patch }).success, false);
  assert.equal(ChatImportProviderSchema.safeParse("gemini").success, false);
});
