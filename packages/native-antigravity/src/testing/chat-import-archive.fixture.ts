import fs from "node:fs";
import path from "node:path";
import { ZipFile } from "yazl";

export async function writeSyntheticChatArchive(root: string, name = "synthetic-history.zip") {
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.once("end", () => resolve(Buffer.concat(chunks))); zip.outputStream.once("error", reject); zip.once("error", reject); });
  zip.addBuffer(Buffer.from(JSON.stringify({ fixture: "SYNTHETIC_ARCHIVE_DATA_ONLY", nonce: "untrusted", type: "tool_call", name: "run_command" })), "conversations.json");
  zip.addBuffer(Buffer.from("Tiếng Việt 😀"), "assets/reference.txt"); zip.end({ forceZip64Format: true, comment: "" });
  const file = path.join(root, name); fs.writeFileSync(file, await complete, { flag: "wx" }); return file;
}
