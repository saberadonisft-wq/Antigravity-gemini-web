import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface ExtensionCredentials { version: 1; profileId: string; token: string }
export function extensionCredentials(directory: string): ExtensionCredentials {
  for (let current=path.resolve(directory);;current=path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error("Connector metadata cannot use linked directories.");
    if (path.dirname(current)===current) break;
  }
  const file = path.join(directory, "extension-connector.json");
  fs.mkdirSync(directory, { recursive: true });
  // Never replace an existing credential or silently pair a different profile.
  if (!fs.existsSync(file)) {
    const value: ExtensionCredentials = { version: 1, profileId: randomUUID(), token: randomBytes(32).toString("hex") };
    try { fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size>2048) throw Error("Invalid connector credential file.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || Object.keys(value).sort().join(",")!=="profileId,token,version" || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.profileId) || !/^[a-f0-9]{64}$/.test(value.token)) throw Error("Invalid connector credentials; no replacement was written.");
  return value;
}
