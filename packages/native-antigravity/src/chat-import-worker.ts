import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { inspectChatImportArchive } from "./chat-import.js";
import { NativeRouteError } from "./native-protocol.js";

if (isMainThread || !parentPort || !workerData || typeof workerData.file !== "string") throw Error("Owned archive inspection worker required");
try {
  let reportedAt = -Infinity;
  const result = await inspectChatImportArchive(workerData.file, workerData.provider, { onProgress: progress => {
    const now = performance.now();
    if (now - reportedAt >= 100 || progress.bytesRead === progress.totalBytes) { reportedAt = now; parentPort!.postMessage({ kind: "progress", ...progress }); }
  } });
  parentPort.postMessage({ kind: "complete", result });
} catch (error) {
  parentPort.postMessage({ kind: "failed", code: error instanceof NativeRouteError && /^IMPORT_[A-Z_]+$/.test(error.code) ? error.code : "IMPORT_INSPECTION_FAILED" });
} finally { parentPort.close(); }
