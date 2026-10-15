import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a), "hex"), Buffer.from(digest(b), "hex"));
}

export function readPrivateFile(file: string, limit = 131072): string {
  const handle = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(handle).isFile() || fs.fstatSync(handle).size > limit) throw Error("Invalid state file");
    return fs.readFileSync(handle, "utf8");
  } finally { fs.closeSync(handle); }
}

export function writePrivateFile(file: string, content: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(handle, content); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

const Pairing = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() }).strict();

/** Owner-only CLI writes the code locally; HTTP never creates or discloses it. */
export function createOwnerPairing(directory: string, now = Date.now()) {
  const code = secret();
  const expiresAt = now + 300000;
  const codeFile = path.join(directory, "owner-pairing-code.txt");
  writePrivateFile(codeFile, code + "\n");
  writePrivateFile(path.join(directory, "owner-pairing.json"), JSON.stringify({ hash: digest(code), expiresAt }));
  return { codeFile, expiresAt };
}

export function consumeOwnerPairing(directory: string, code: string, now: number): boolean {
  const file = path.join(directory, "owner-pairing.json");
  const claimed = file + "." + randomUUID() + ".used";
  try {
    const entry = Pairing.parse(JSON.parse(readPrivateFile(file, 1024)));
    if (entry.expiresAt <= now || code.length !== 43 || !sameSecret(entry.hash, digest(code))) return false;
    // Claim before issuing a grant. A concurrent replacement cannot authorize an older code.
    fs.renameSync(file, claimed);
    const actual = Pairing.parse(JSON.parse(readPrivateFile(claimed, 1024)));
    if (actual.hash !== entry.hash || actual.expiresAt !== entry.expiresAt) return false;
    try { fs.unlinkSync(path.join(directory, "owner-pairing-code.txt")); } catch {}
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(claimed); } catch {} }
}
