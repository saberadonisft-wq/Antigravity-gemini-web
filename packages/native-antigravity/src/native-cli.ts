import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { McpNativeBrowserBackend } from "./browser-backend.js";
import { startNativeProxy, NATIVE_PROXY_PORT } from "./native-proxy.js";
import { inspectIde, nativeHome, isolatedIdeProfile, configureIsolatedProfile, atomicPrivateFile, assertNoLinks } from "./installation.js";
import { NativeRouteError } from "./native-protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const endpoint = "http://127.0.0.1:" + NATIVE_PROXY_PORT;
const descriptor = path.join(nativeHome, "proxy-owner.json");
const command = process.argv[2] ?? "check";
async function health() {
  const response = await fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) });
  const value = await response.json();
  if (!response.ok || value.service !== "gemini-native-proxy" || value.version !== 1) throw new NativeRouteError("INVALID_SERVICE", "The configured port belongs to another service.");
  return value;
}
try {
  if (command === "check") {
    console.log(JSON.stringify({ ...inspectIde(), endpoint, isolatedIdeProfile, vendorFilesModified: false, nativeInference: "unverified_until_live_acceptance" }, null, 2));
  } else if (command === "setup" || command === "restore") {
    inspectIde();
    console.log(JSON.stringify(configureIsolatedProfile(isolatedIdeProfile, endpoint, command), null, 2));
  } else if (command === "status") {
    console.log(JSON.stringify(await health(), null, 2));
  } else if (command === "stop" || command === "browser") {
    const status = await health();
    assertNoLinks(descriptor);
    const owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (owner.pid !== status.pid || owner.endpoint !== endpoint || typeof owner.controlToken !== "string") throw new NativeRouteError("OWNER_MISMATCH", "Proxy ownership could not be established.");
    const result = await fetch(endpoint + "/__native/" + command, { method: "POST", headers: { "x-native-control-token": owner.controlToken }, signal: AbortSignal.timeout(command === "browser" ? 30000 : 3000) });
    const value = await result.json();
    if (!result.ok) throw new NativeRouteError(value?.error?.code ?? "CONTROL_REFUSED", value?.error?.message ?? "Proxy is active or could not verify its owner.");
    console.log(JSON.stringify(value, null, 2));
  } else if (command === "start") {
    inspectIde(); assertNoLinks(nativeHome); fs.mkdirSync(nativeHome, { recursive: true });
    const controlToken = randomBytes(32).toString("hex");
    const backend = new McpNativeBrowserBackend(path.join(root, "packages/mcp-server/dist/cli.js"));
    const proxy = await startNativeProxy({ backend, stateDirectory: nativeHome, controlToken });
    atomicPrivateFile(descriptor, JSON.stringify({ version: 1, pid: process.pid, endpoint, controlToken }) + "\n");
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return; shuttingDown = true;
      const watchdog = setTimeout(() => process.exit(1), 6000);
      try { await proxy.close(); }
      finally {
        if (fs.existsSync(descriptor) && JSON.parse(fs.readFileSync(descriptor, "utf8")).pid === process.pid) fs.unlinkSync(descriptor);
        clearTimeout(watchdog);
      }
    };
    process.once("SIGINT", () => { void cleanup(); }); process.once("SIGTERM", () => { void cleanup(); });
    proxy.server.once("close", () => { void cleanup(); });
    console.log(JSON.stringify({ listening: endpoint, model: "Gemini Web (Local)", mode: "gemini_web", isolatedIdeProfile, nativeInference: "unverified_until_live_acceptance" }));
  } else if (command === "launch") {
    const ide = inspectIde();
    configureIsolatedProfile(isolatedIdeProfile, endpoint);
    try { await health(); }
    catch (error) {
      if (error instanceof NativeRouteError) throw error;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], { detached: true, windowsHide: true, stdio: "ignore" });
      child.on("error", () => {}); child.unref();
      const deadline = performance.now() + 8000; let ready = false;
      while (performance.now() < deadline) {
        try { await health(); ready = true; break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new NativeRouteError("PROXY_START_FAILED", "Proxy did not become ready. Run native:start to inspect its sanitized error.");
    }
    // Visible on purpose: the user needs to see this isolated IDE and complete its own login.
    const ideEnvironment = { ...process.env };
    delete ideEnvironment.ELECTRON_RUN_AS_NODE; delete ideEnvironment.NODE_OPTIONS;
    const child = spawn(ide.executable, ["--user-data-dir", isolatedIdeProfile, "--new-window", root], { detached: true, windowsHide: false, stdio: "ignore", env: ideEnvironment });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    console.log(JSON.stringify({ launchRequested: true, endpoint, isolatedIdeProfile, selectModel: "Gemini Web (Local)", accountLogin: "Complete Google sign-in in the isolated IDE if requested.", browserLogin: "Use the existing Gemini Web browser MCP profile; credentials are never copied." }, null, 2));
  } else throw new NativeRouteError("INVALID_COMMAND", "Use check, setup, start, launch, browser, status, stop or restore.");
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof NativeRouteError ? error.code : "NATIVE_COMMAND_FAILED", message: error instanceof NativeRouteError ? error.message : "Native route command failed; no credentials or source payload are logged." }));
  process.exitCode = 1;
}
