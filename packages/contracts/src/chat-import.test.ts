import test from "node:test";
import assert from "node:assert/strict";
import { ChatImportInspectionSchema, ChatImportProviderSchema, ChatImportSurfaceObservationSchema, ChatImportProbeRequestSchema } from "./chat-import.js";

test("Import surface observations cannot imply transmission or grant authority from unverified controls", () => {
  const observation={status:"controls_observed",observedAt:new Date().toISOString(),identityVerified:true,surfaceId:"a".repeat(64),chatUploadControlObserved:true,memoryControlsObserved:false,evidence:"visible_controls_only",googleSubmission:"not_submitted"};
  assert.equal(ChatImportSurfaceObservationSchema.safeParse(observation).success,true);
  for(const patch of [{identityVerified:false},{surfaceId:undefined},{googleSubmission:"completed"},{status:"not_observed"},{url:"https://private"},{accountIdentity:"private@example.test"}])assert.equal(ChatImportSurfaceObservationSchema.safeParse({...observation,...patch}).success,false);
  const probe={action:"probe",expectedOwnerId:"00000000-0000-4000-8000-000000000001",expectedAccountRevision:1,accountId:"account_fixture",identityEpoch:1};
  assert.equal(ChatImportProbeRequestSchema.safeParse(probe).success,true);assert.equal(ChatImportProbeRequestSchema.safeParse({...probe,file:"C:/private.zip"}).success,false);
});

test("Import inspection cannot claim upload, Google compatibility, account migration or contain local paths/content", () => {
  const result = { version: 1, declaredProvider: "chatgpt", fileName: "export.zip", bytes: 100, sha256: "a".repeat(64), checkedAt: new Date().toISOString(),
    directory: { entries: 1, files: 1, folders: 0, encryptedFiles: 0, compressedBytes: "10", uncompressedBytes: "90071992547409910" },
    inspection: "directory_metadata_only", contentsCrcVerified: false, googleSubmission: "not_submitted", googleCompatibility: "requires_live_validation" };
  assert.equal(ChatImportInspectionSchema.safeParse(result).success, true);
  for (const patch of [{ googleSubmission: "completed" }, { googleCompatibility: "verified" }, { contents: "private chat" }, { fileName: "C:\\private\\export.zip" }, { fileName: "../export.zip" }, { bytes: 5000000001 }, { directory: { ...result.directory, folders: 1 } }]) assert.equal(ChatImportInspectionSchema.safeParse({ ...result, ...patch }).success, false);
  assert.equal(ChatImportProviderSchema.safeParse("gemini").success, false);
});
