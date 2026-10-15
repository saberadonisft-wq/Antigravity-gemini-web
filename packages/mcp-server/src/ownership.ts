import { createServer } from "node:net";
import { createHash } from "node:crypto";

export async function acquireOwnership(scope: string) {
  const key = createHash("sha256").update(process.platform === "win32" ? scope.toLowerCase() : scope).digest("hex");
  const owner = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    owner.once("error", reject);
    owner.listen(process.platform === "win32" ? { path: `\\\\.\\pipe\\gemini-mcp-${key}` } : { host: "127.0.0.1", port: 49152 + Number.parseInt(key.slice(0, 4), 16) % 16000, exclusive: true }, resolve);
  });
  return owner;
}
