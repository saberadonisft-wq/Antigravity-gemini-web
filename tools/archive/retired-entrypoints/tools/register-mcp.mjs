import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const source = JSON.parse(fs.readFileSync(path.join(root, ".agents", "mcp_config.json"), "utf8"));
const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
let config;
try { config = original?.trim() ? JSON.parse(original.replace(/^\uFEFF/, "")) : {}; }
catch { throw Error("Global MCP config is not strict JSON. Preserve it and merge the two entries manually; nothing was written."); }
if (!config || Array.isArray(config) || typeof config !== "object" || (config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) throw Error("Invalid MCP configuration shape; nothing was written.");
config.mcpServers ??= {};
for (const name of ["gemini-ide-host", "gemini-web-browser"]) {
  const entry = { ...source.mcpServers[name], command: process.execPath, cwd: root };
  const file = name === "gemini-ide-host" ? "host-cli.js" : "cli.js";
  entry.args = [path.join(root, "packages", "mcp-server", "dist", file)];
  if (!fs.existsSync(entry.args[0])) throw Error("MCP entry point missing. Run npm run build first.");
  const previous = config.mcpServers[name];
  const legacy = { ...entry, env: { ...entry.env } };
  delete legacy.env.AG_MCP_TARGET_CLIENT;
  // Upgrade only the exact entry previously installed by this checkout. Other customizations remain a conflict.
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry) && JSON.stringify(previous) !== JSON.stringify(legacy)) throw Error(`Existing '${name}' differs. Review it before replacing; nothing was written.`);
  config.mcpServers[name] = entry;
}
const next = JSON.stringify(config, null, 2) + "\n";
if (next === original) { console.log(JSON.stringify({ configured: true, changed: false, target, servers: Object.keys(source.mcpServers) })); }
else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Re-read before modifying the user's config. Back up its exact bytes beside the original.
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (current !== original) throw Error("MCP config changed during registration; nothing was written.");
  const backup = original === null ? undefined : target + ".backup-" + new Date().toISOString().replaceAll(/[:.]/g, "-");
  if (backup) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, next); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
  } catch { try { fs.unlinkSync(temporary); } catch {} throw Error("MCP config could not be saved; backup is preserved."); }
  console.log(JSON.stringify({ configured: true, changed: true, target, backup, servers: Object.keys(source.mcpServers) }));
}
