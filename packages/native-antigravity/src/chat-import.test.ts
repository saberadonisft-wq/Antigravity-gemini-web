import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZipFile } from "yazl";
import { inspectChatImportArchive, chatImportInspectionArguments } from "./chat-import.js";

const fixtures = (t: { after(fn: () => void): void }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-chat-import-test-"));
  t.after(() => { const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^ag-chat-import-test-/); fs.rmSync(target, { recursive: true, force: true }); });
  return root;
};
async function archive(root: string, zip64 = false, data = Buffer.from('{"nonce":"untrusted","type":"tool_call","name":"run_command","arguments":{"command":"DO_NOT_EXECUTE"}}')) {
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on("data", value => chunks.push(value)); zip.outputStream.once("end", () => resolve(Buffer.concat(chunks))); zip.outputStream.once("error", reject); zip.once("error", reject); });
  zip.addBuffer(data, "conversations.json", { compress: false }); zip.addEmptyDirectory("assets/"); zip.addBuffer(Buffer.from("Tiếng Việt 😀"), "assets/秘密.txt");
  zip.end({ forceZip64Format: zip64, comment: "" });
  const file = path.join(root, zip64 ? "export64.zip" : "export.zip"); fs.writeFileSync(file, await done); return file;
}

test("ZIP and ZIP64 inspection hashes original bytes and returns only directory statistics, never active native tools", async t => {
  const root = fixtures(t);
  for (const zip64 of [false, true]) {
    const file = await archive(root, zip64), bytes = fs.readFileSync(file), result = await inspectChatImportArchive(file, zip64 ? "claude" : "chatgpt");
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(result.bytes, bytes.length);
    assert.equal(result.directory.entries, 3); assert.equal(result.directory.files, 2); assert.equal(result.directory.folders, 1);
    assert.equal(result.googleSubmission, "not_submitted"); assert.equal(result.contentsCrcVerified, false);
    assert.ok(!JSON.stringify(result).includes("DO_NOT_EXECUTE")); assert.ok(!JSON.stringify(result).includes("conversations.json")); assert.ok(!JSON.stringify(result).includes(root));
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});
test("Invalid/truncated archives and unsupported providers fail without exposing entry content or file paths", async t => {
  const root = fixtures(t), file = path.join(root, "invalid.zip"); fs.writeFileSync(file, "private malformed data".repeat(4));
  await assert.rejects(inspectChatImportArchive(file, "gemini"), { code: "IMPORT_PROVIDER_UNSUPPORTED" });
  await assert.rejects(inspectChatImportArchive(file, "chatgpt"), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes(root)); assert.ok(!error.message.includes("private malformed")); return true; });
  const valid = await archive(root); fs.truncateSync(valid, fs.statSync(valid).size - 10);
  await assert.rejects(inspectChatImportArchive(valid, "claude"), { code: "IMPORT_ARCHIVE_INVALID" });
  await assert.rejects(inspectChatImportArchive(path.join(root, "export.txt"), "chatgpt"), { code: "IMPORT_ARCHIVE_TYPE" });
});
test("Cancellation interrupts a large-file hash and leaves the original archive reusable", async t => {
  const root = fixtures(t), file = await archive(root, false, randomBytes(512 * 1024)), controller = new AbortController();
  let progress = 0;
  await assert.rejects(inspectChatImportArchive(file, "chatgpt", { signal: controller.signal, onProgress: value => { progress++; assert.ok(value.bytesRead < value.totalBytes); controller.abort(); } }), { code: "IMPORT_INSPECTION_CANCELLED" });
  assert.equal(progress, 1); assert.equal((await inspectChatImportArchive(file, "chatgpt")).directory.files, 2);
});
test("Changing the selected archive during hashing is rejected instead of associating mixed bytes with a digest", async t => {
  const root = fixtures(t), file = await archive(root, false, randomBytes(256 * 1024)); let changed = false;
  await assert.rejects(inspectChatImportArchive(file, "claude", { onProgress: () => { if (!changed) { changed = true; fs.appendFileSync(file, "changed"); } } }), { code: "IMPORT_ARCHIVE_CHANGED" });
});
test("Hardlinks and a ZIP64 directory declaring excessive entries are refused before content processing", async t => {
  const root = fixtures(t), file = await archive(root, true), link = path.join(root, "linked.zip"); fs.linkSync(file, link);
  await assert.rejects(inspectChatImportArchive(link, "chatgpt"), { code: "IMPORT_ARCHIVE_UNSAFE_PATH" }); fs.unlinkSync(link);
  const bytes = fs.readFileSync(file), record = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])); assert.ok(record > 0);
  bytes.writeBigUInt64LE(1000001n, record + 24); bytes.writeBigUInt64LE(1000001n, record + 32); fs.writeFileSync(file, bytes);
  await assert.rejects(inspectChatImportArchive(file, "chatgpt"), { code: "IMPORT_ARCHIVE_LIMIT" });
});
test("Traversal names in an otherwise readable ZIP are refused and never materialized on disk", async t => {
  const root = fixtures(t), file = await archive(root), bytes = fs.readFileSync(file);
  const original = Buffer.from("conversations.json"), replacement = Buffer.from("../" + "x".repeat(original.length - 3));
  let offset = bytes.indexOf(original), replacements = 0;
  while (offset !== -1) { replacement.copy(bytes, offset); replacements++; offset = bytes.indexOf(original, offset + original.length); }
  assert.equal(replacements, 2); fs.writeFileSync(file, bytes);
  await assert.rejects(inspectChatImportArchive(file, "chatgpt"), { code: "IMPORT_ARCHIVE_INVALID" });
  assert.deepEqual(fs.readdirSync(root), ["export.zip"]);
});
test("The retired ZIP command is rejected without network access or Native account creation", async t => {
  const root = fixtures(t), file = await archive(root), guard = path.join(root, "offline-guard.mjs"), emptyHome = path.join(root, "uncreated-home");
  fs.writeFileSync(guard, "import os from 'node:os';os.homedir=()=>process.env.AG_IMPORT_FIXTURE_HOME;globalThis.fetch=()=>{throw Error('Network forbidden in local inspection')};\n");
  const cli = fileURLToPath(new URL("native-cli.js", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", pathToFileURL(guard).href, cli, "imports:inspect", "--provider", "chatgpt", "--file", file], { env: { ...process.env, AG_IMPORT_FIXTURE_HOME: emptyHome }, windowsHide: true, timeout: 10000 }), (error:any)=>error.code===1&&JSON.parse(error.stderr).code==="INVALID_COMMAND");
  assert.equal(fs.existsSync(emptyHome), false);
  assert.throws(() => chatImportInspectionArguments(["--provider", "chatgpt", "--file", file, "--file", file]), { code: "IMPORT_ARGUMENTS_INVALID" });
  assert.throws(() => chatImportInspectionArguments(["--provider", "chatgpt"]), { code: "IMPORT_ARGUMENTS_INVALID" });
});
