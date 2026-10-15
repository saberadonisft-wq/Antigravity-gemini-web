import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function removeOwnedFixture(directory: string) {
  const target = fs.realpathSync(directory);
  const temp = fs.realpathSync(os.tmpdir());
  const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(path.dirname(target), temp) || !/^gemini-mcp-(host-)?test-/.test(path.basename(target))) throw Error("Invalid owned MCP fixture cleanup target");
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
