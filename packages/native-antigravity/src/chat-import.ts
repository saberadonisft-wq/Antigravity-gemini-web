import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { RandomAccessReader, fromRandomAccessReaderPromise, type ZipFile } from "yauzl";
import { CHAT_IMPORT_MAX_ARCHIVE_BYTES, CHAT_IMPORT_MAX_ENTRIES, ChatImportProviderSchema, ChatImportInspectionSchema, type ChatImportInspection } from "@antigravity-gemini-web/contracts";
import { assertNoLinks } from "./installation.js";
import { NativeRouteError } from "./native-protocol.js";

export interface ChatImportInspectionOptions {
  signal?: AbortSignal;
  onProgress?(progress: { bytesRead: number; totalBytes: number }): void;
}
const failure = (code: string) => new NativeRouteError(code, "Local chat archive inspection failed. Check the selected ZIP file; no data was submitted to Google.", 422);
function checkedPath(input: string) {
  if (!input || path.extname(input).toLowerCase() !== ".zip") throw failure("IMPORT_ARCHIVE_TYPE");
  const absolute = path.resolve(input);
  if (process.platform === "win32") {
    const root = path.parse(absolute).root;
    if (!/^[a-z]:\\$/i.test(root)) throw failure("IMPORT_ARCHIVE_UNSAFE_PATH");
    for (const part of absolute.slice(root.length).split(path.sep)) {
      if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw failure("IMPORT_ARCHIVE_UNSAFE_PATH");
    }
  }
  assertNoLinks(absolute);
  return absolute;
}
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n;

class HeldArchiveReader extends RandomAccessReader {
  constructor(private readonly handle: FileHandle, private readonly signal: AbortSignal) { super(); }
  _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle, signal = this.signal;
    return Readable.from((async function* () {
      for (let position = start; position < end;) {
        signal.throwIfAborted(); const buffer = Buffer.allocUnsafe(Math.min(65536, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        signal.throwIfAborted();
        if (!bytesRead) throw failure("IMPORT_ARCHIVE_CHANGED");
        position += bytesRead; yield buffer.subarray(0, bytesRead);
      }
    })(), { objectMode: false, highWaterMark: 65536 });
  }
  // The inspector owns the handle. Closing the ZIP reader must not close the
  // descriptor needed for the final file identity/change checks.
  close(callback: (error: Error | null) => void) { queueMicrotask(() => callback(null)); }
}

async function directory(handle: FileHandle, bytes: number, signal: AbortSignal): Promise<ChatImportInspection["directory"]> {
  let zip: ZipFile | undefined;
  try {
    zip = await fromRandomAccessReaderPromise(new HeldArchiveReader(handle, signal), bytes, { autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
    signal.throwIfAborted();
    if (zip.entryCount > CHAT_IMPORT_MAX_ENTRIES) throw failure("IMPORT_ARCHIVE_LIMIT");
    const file = zip;
    return await new Promise((resolve, reject) => {
      let done = false, entries = 0, files = 0, folders = 0, encryptedFiles = 0, compressedBytes = 0n, uncompressedBytes = 0n;
      const finish = (error?: unknown) => {
        if (done) return; done = true; signal.removeEventListener("abort", abort); file.close();
        if (error) reject(error);
        else if (!files) reject(failure("IMPORT_ARCHIVE_EMPTY"));
        else resolve({ entries, files, folders, encryptedFiles, compressedBytes: String(compressedBytes), uncompressedBytes: String(uncompressedBytes) });
      };
      const abort = () => finish(signal.reason ?? failure("IMPORT_INSPECTION_CANCELLED"));
      // Keep an error listener after close to consume any late I/O completion.
      file.on("error", error => finish(error));
      file.once("end", () => finish());
      file.on("entry", entry => {
        if (done) return;
        try {
          signal.throwIfAborted(); entries++;
          if (entries > CHAT_IMPORT_MAX_ENTRIES) throw failure("IMPORT_ARCHIVE_LIMIT");
          if (entry.fileName.endsWith("/")) folders++;
          else {
            files++; if (entry.isEncrypted()) encryptedFiles++;
            if (![entry.compressedSize, entry.uncompressedSize].every(value => Number.isSafeInteger(value) && value >= 0)) throw failure("IMPORT_ARCHIVE_LIMIT");
            compressedBytes += BigInt(entry.compressedSize); uncompressedBytes += BigInt(entry.uncompressedSize);
          }
          file.readEntry();
        } catch (error) { finish(error); }
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else file.readEntry();
    });
  } finally { zip?.close(); }
}

/** Read only: no extraction, content parsing, account mutation or network calls. */
export async function inspectChatImportArchive(filename: string, providerInput: unknown, options: ChatImportInspectionOptions = {}): Promise<ChatImportInspection> {
  const provider = ChatImportProviderSchema.safeParse(providerInput);
  if (!provider.success) throw failure("IMPORT_PROVIDER_UNSUPPORTED");
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(600000)]);
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    signal.throwIfAborted();
    const absolute = checkedPath(filename), canonical = await fs.promises.realpath(absolute);
    handle = await fs.promises.open(canonical, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw failure("IMPORT_ARCHIVE_UNSAFE_PATH");
    if (before.size < 22n || before.size > BigInt(CHAT_IMPORT_MAX_ARCHIVE_BYTES)) throw failure("IMPORT_ARCHIVE_LIMIT");
    const bytes = Number(before.size), hash = createHash("sha256"); let bytesRead = 0;
    const buffer = Buffer.allocUnsafe(65536);
    while (bytesRead < bytes) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, 0, Math.min(buffer.length, bytes - bytesRead), bytesRead);
      signal.throwIfAborted();
      if (!read.bytesRead) throw failure("IMPORT_ARCHIVE_CHANGED");
      bytesRead += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead)); options.onProgress?.({ bytesRead, totalBytes: bytes });
    }
    signal.throwIfAborted();
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw failure("IMPORT_ARCHIVE_CHANGED");
    const catalogue = await directory(handle, bytes, signal);
    signal.throwIfAborted(); assertNoLinks(absolute);
    const after = await handle.stat({ bigint: true }), selected = await fs.promises.stat(absolute, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, selected) || await fs.promises.realpath(absolute) !== canonical) throw failure("IMPORT_ARCHIVE_CHANGED");
    return ChatImportInspectionSchema.parse({
      version: 1, declaredProvider: provider.data, fileName: path.basename(canonical), bytes, sha256: hash.digest("hex"), checkedAt: new Date().toISOString(), directory: catalogue,
      inspection: "directory_metadata_only", contentsCrcVerified: false, googleSubmission: "not_submitted", googleCompatibility: "requires_live_validation",
    });
  } catch (error) {
    if (signal.aborted) throw new NativeRouteError("IMPORT_INSPECTION_CANCELLED", "Local archive inspection was cancelled or exceeded its time budget; no data was submitted.", 499);
    if (error instanceof NativeRouteError && error.code.startsWith("IMPORT_")) throw error;
    throw failure("IMPORT_ARCHIVE_INVALID");
  } finally { await handle?.close(); }
}

export function chatImportInspectionArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--provider", "--file"].includes(key) || !value || values.has(key)) throw failure("IMPORT_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  if (values.size !== 2) throw failure("IMPORT_ARGUMENTS_INVALID");
  return { provider: values.get("--provider")!, file: values.get("--file")! };
}
