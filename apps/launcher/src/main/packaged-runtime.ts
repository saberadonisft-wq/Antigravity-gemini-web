import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

/** Runs only the runtime shipped alongside the desktop app, without a shell. */
export async function runBundledCommand(resources: string, action: "ensure" | "launch" | "stop", workspace?: string): Promise<void> {
  const root = path.join(resources, "app");
  const node = path.join(resources, "node", "node.exe");
  const cli = path.join(root, "packages", "native-antigravity", "dist", "native-cli.js");
  if (!fs.existsSync(node) || !fs.existsSync(cli)) throw Error("BUNDLED_RUNTIME_MISSING");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const args = [cli, action, ...(workspace ? ["--workspace", workspace] : [])];
  await new Promise<void>((resolve, reject) => {
    execFile(node, args, { cwd: root, env, windowsHide: true, timeout: 20000, maxBuffer: 65536 }, (error, _stdout, stderr) => {
      if (!error) { resolve(); return; }
      let code = "NATIVE_START_FAILED";
      try {
        const result = JSON.parse(stderr.trim().split(/\r?\n/).at(-1) ?? "");
        if (typeof result.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(result.code)) code = result.code;
      } catch {}
      reject(Error(code));
    });
  });
}
