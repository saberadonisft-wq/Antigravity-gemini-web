import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { McpNativeBrowserBackend } from "./browser-backend.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { AccountRegistry } from "./account-registry.js";
import { startNativeProxy, NATIVE_PROXY_PORT, NATIVE_RUNTIME_REVISION } from "./native-proxy.js";
import { inspectIde, nativeHome, isolatedIdeProfile, configureIsolatedProfile, atomicPrivateFile, assertNoLinks } from "./installation.js";
import { NativeRouteError } from "./native-protocol.js";
import { inspectChatImportArchive, chatImportInspectionArguments } from "./chat-import.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const endpoint = "http://127.0.0.1:" + NATIVE_PROXY_PORT;
const descriptor = path.join(nativeHome, "proxy-owner.json");
const command = process.argv[2] ?? "check";

function getRegistry(): AccountRegistry {
  assertNoLinks(nativeHome);
  fs.mkdirSync(nativeHome, { recursive: true });
  const registryPath = path.join(nativeHome, "accounts.json");
  const registry = new AccountRegistry(registryPath);
  const defaultProfile = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data", "browser_profile");
  const defaultState = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data", "mcp");
  registry.ensureDefault({ profilePath: defaultProfile, statePath: defaultState, debugPort: 9223 });
  return registry;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

async function health() {
  const response = await fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) });
  const value = await response.json();
  if (!response.ok || value.service !== "gemini-native-proxy" || value.version !== 1) throw new NativeRouteError("INVALID_SERVICE", "The configured port belongs to another service.");
  return value;
}

async function ownerControl(action: "browser" | "cancel" | "stop" | "resume" | "account" | "reconcile" | "router" | "manage" | "knowledge", body?: unknown) {
  const status = await health();
  assertNoLinks(descriptor);
  const owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  if (owner.pid !== status.pid || owner.endpoint !== endpoint || typeof owner.controlToken !== "string") throw new NativeRouteError("OWNER_MISMATCH", "Proxy ownership could not be established.");
  const controlTimeout = action === "browser" || action === "account" || action === "manage" || action === "knowledge" ? 30000 : action === "reconcile" ? 120000 : 5000;
  const response = await fetch(endpoint + "/__native/" + action, { method: "POST", headers: { "x-native-control-token": owner.controlToken, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(controlTimeout) });
  const value = await response.json();
  if (!response.ok) throw new NativeRouteError(value?.error?.code ?? "CONTROL_REFUSED", value?.error?.message ?? "Proxy is active or could not verify its owner.");
  return value;
}

async function isProxyRunning(): Promise<boolean> {
  try {
    await health();
    return true;
  } catch (error) {
    if (error instanceof NativeRouteError) throw error;
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED") return false;
    throw new NativeRouteError("PROXY_UNAVAILABLE", "Native runtime state could not be verified. No offline account mutation was performed.", 503);
  }
}

try {
  if (command === "imports:inspect") {
    const selected = chatImportInspectionArguments(process.argv.slice(3));
    console.log(JSON.stringify(await inspectChatImportArchive(selected.file, selected.provider), null, 2));
  } else if (command === "check") {
    console.log(JSON.stringify({ ...inspectIde(), endpoint, isolatedIdeProfile, vendorFilesModified: false, nativeInference: "unverified_until_live_acceptance" }, null, 2));
  } else if (command === "setup" || command === "restore") {
    inspectIde();
    console.log(JSON.stringify(configureIsolatedProfile(isolatedIdeProfile, endpoint, command), null, 2));
  } else if (command === "status") {
    console.log(JSON.stringify(await health(), null, 2));
  } else if (command === "stop" || command === "cancel") {
    console.log(JSON.stringify(await ownerControl(command), null, 2));
  } else if (command === "browser" || command === "account:browser") {
    const target = process.argv[3];
    const registry = getRegistry();
    const account = target ? registry.find(target) : registry.getActive();
    if (target && !account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", `Account '${target}' not found.`);
    if (await isProxyRunning()) {
      console.log(JSON.stringify(await ownerControl("browser", account ? { accountId: account.accountId } : undefined), null, 2));
    } else {
      if (!account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", "No active or configured account.");
      const cliPath = path.join(root, "packages/mcp-server/dist/cli.js");
      const backend = new McpNativeBrowserBackend(cliPath, {
        AG_MCP_BROWSER_PROFILE: account.profilePath,
        AG_MCP_STATE_DIR: account.statePath,
        AG_MCP_DEBUG_PORT: String(account.debugPort),
      });
      try {
        console.log(JSON.stringify(await backend.openBrowser(), null, 2));
      } finally {
        await backend.close().catch(() => {});
      }
    }
  } else if(command==="knowledge"||command.startsWith("knowledge:")){
    const option=(flag:string)=>{const index=process.argv.indexOf(flag);return index>=0?process.argv[index+1]:undefined;};
    const repeated=(flag:string)=>process.argv.flatMap((value,index)=>value===flag&&process.argv[index+1]?[process.argv[index+1]]:[]);
    const status=await ownerControl("knowledge",{action:"status"}),authority={expectedOwnerId:status.ownerId,expectedRevision:status.revision};
    if(command==="knowledge"||command==="knowledge:status")console.log(JSON.stringify(status,null,2));
    else{
      let request:unknown;
      if(command==="knowledge:import")request={action:"import_code",source:{kind:option("--github")?"github_checkout":"local_folder",label:option("--label"),root:option("--root"),files:repeated("--file"),overlayFiles:repeated("--overlay"),repository:option("--github")},...authority};
      else if(command==="knowledge:register")request={action:"register_external",kind:process.argv[3],label:option("--label"),url:option("--url"),instructionVersion:option("--instruction-version"),...authority};
      else if(command==="knowledge:refresh"||command==="knowledge:check"||command==="knowledge:remove")request={action:command==="knowledge:refresh"?"refresh":command==="knowledge:remove"?"remove":"check",sourceId:process.argv[3],...(command==="knowledge:refresh"&&repeated("--overlay").length?{overlayFiles:repeated("--overlay")} :{}),...authority};
      else if(command==="knowledge:bind"||command==="knowledge:clear"){
        const target=option("--account"),account=target?getRegistry().find(target):undefined;
        if(!account||!option("--task"))throw new NativeRouteError("INVALID_ARGUMENT","Choose an explicit --account and --task for project knowledge.");
        request={action:"bind",taskScope:option("--task"),accountId:account.accountId,identityEpoch:account.identityEpoch,sourceIds:command==="knowledge:clear"?[]:repeated("--source"),...authority};
      }else throw new NativeRouteError("INVALID_ARGUMENT","Use knowledge, knowledge:import, knowledge:register, knowledge:check, knowledge:refresh, knowledge:remove, knowledge:bind or knowledge:clear.");
      console.log(JSON.stringify(await ownerControl("knowledge",request),null,2));
    }
  } else if(command==="accounts:status"){
    console.log(JSON.stringify(await ownerControl("manage",{action:"status"}),null,2));
  } else if (command === "accounts" || command === "account:list") {
    const registry = getRegistry();
    const accounts = registry.list();
    const active = registry.getActive();
    console.log(JSON.stringify({
      activeAccountId: active?.accountId,
      activeDisplayName: active?.displayName,
      revision: registry.snapshot().revision,
      total: accounts.length,
      accounts: accounts.map(a => ({
        accountId: a.accountId,
        displayName: a.displayName,
        debugPort: a.debugPort,
        active: a.accountId === active?.accountId,
        enabled: a.enabled,
        identityRegistered: !!a.identityFingerprint,
        identityEpoch: a.identityEpoch,
        profilePath: a.profilePath,
      })),
    }, null, 2));
  } else if (command === "account:add") {
    const name = process.argv[3];
    if (!name || name.startsWith("--")) throw new NativeRouteError("INVALID_ARGUMENT", "Account name required: account:add <name> [--profile <path>] [--state <path>] [--port <port>]");
    const profileIdx = process.argv.indexOf("--profile");
    const stateIdx = process.argv.indexOf("--state");
    const portIdx = process.argv.indexOf("--port");
    if(await isProxyRunning()){
      if(profileIdx>=0||stateIdx>=0||portIdx>=0)throw new NativeRouteError("UNSUPPORTED_OPERATION","Custom account paths/ports require an offline native owner. Online additions use owner-generated isolated paths.",412);
      const status=await ownerControl("manage",{action:"status"});
      console.log(JSON.stringify(await ownerControl("manage",{action:"add",displayName:name,expectedOwnerId:status.ownerId,expectedRevision:status.revision}),null,2));
    }else{
    const profilePath = profileIdx >= 0 ? process.argv[profileIdx + 1] : path.join(nativeHome, "accounts", slugify(name), "browser_profile");
    const statePath = stateIdx >= 0 ? process.argv[stateIdx + 1] : path.join(nativeHome, "accounts", slugify(name), "mcp");
    const debugPort = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : undefined;
    const registry = getRegistry();
    const record = registry.add({ displayName: name, profilePath, statePath, debugPort });
    console.log(JSON.stringify({ added: record }, null, 2));
    }
  } else if (command === "account:use") {
    const target = process.argv[3];
    if (!target) throw new NativeRouteError("INVALID_ARGUMENT", "Account id or name required: account:use <id|name>");
    const registry = getRegistry();
    const found = registry.find(target);
    if (!found) throw new NativeRouteError("ACCOUNT_NOT_FOUND", `Account '${target}' not found.`);
    if (await isProxyRunning()) {
      await ownerControl("account", { action: "use", accountId: found.accountId, expectedRevision: registry.snapshot().revision });
    } else {
      registry.setActive(found.accountId);
    }
    console.log(JSON.stringify({ activeAccount: registry.getActive() }, null, 2));
  } else if (command === "account:disable") {
    const target = process.argv[3];
    if (!target) throw new NativeRouteError("INVALID_ARGUMENT", "Account id or name required: account:disable <id|name>");
    const registry = getRegistry();
    const found = registry.find(target);
    if (!found) throw new NativeRouteError("ACCOUNT_NOT_FOUND", `Account '${target}' not found.`);
    if (await isProxyRunning()) {
      await ownerControl("account", { action: "disable", accountId: found.accountId, expectedRevision: registry.snapshot().revision });
    } else {
      registry.disable(found.accountId);
    }
    console.log(JSON.stringify({ disabledAccount: found.displayName, activeAccount: registry.getActive() }, null, 2));
  } else if (command === "account:enable") {
    const target = process.argv[3];
    if (!target) throw new NativeRouteError("INVALID_ARGUMENT", "Account id or name required: account:enable <id|name>");
    const registry = getRegistry();
    const found = registry.find(target);
    if (!found) throw new NativeRouteError("ACCOUNT_NOT_FOUND", `Account '${target}' not found.`);
    if (await isProxyRunning()) {
      await ownerControl("account", { action: "enable", accountId: found.accountId, expectedRevision: registry.snapshot().revision });
    } else {
      registry.enable(found.accountId);
    }
    console.log(JSON.stringify({ enabledAccount: found.displayName, activeAccount: registry.getActive() }, null, 2));
  } else if (command === "account:verify") {
    const registry = getRegistry(), target = process.argv[3];
    const account = target ? registry.find(target) : registry.getActive();
    if (!account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", "Select an account to verify.");
    if (await isProxyRunning()) console.log(JSON.stringify(await ownerControl("account", { action: "verify", accountId: account.accountId }), null, 2));
    else {
      const pool = new NativeBrowserBackendPool(registry, path.join(root, "packages/mcp-server/dist/cli.js"));
      try { console.log(JSON.stringify(await pool.verifyAccount(account.accountId, AbortSignal.timeout(25000)), null, 2)); }
      finally { await pool.close(); }
    }
  } else if (command === "account:check") {
    const target = process.argv[3];
    const registry = getRegistry();
    const account = target ? registry.find(target) : registry.getActive();
    if (!account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", target ? `Account '${target}' not found.` : "No active account configured.");
    const profileExists = fs.existsSync(account.profilePath);
    const stateExists = fs.existsSync(account.statePath);
    console.log(JSON.stringify({
      accountId: account.accountId,
      displayName: account.displayName,
      debugPort: account.debugPort,
      enabled: account.enabled,
      profilePath: account.profilePath,
      profileExists,
      statePath: account.statePath,
      stateExists,
      identityRegistered: !!account.identityFingerprint,
      identityEpoch: account.identityEpoch,
      identityFingerprint: account.identityFingerprint ?? "unverified",
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }, null, 2));
  } else if(command==="routing"||command==="routing:set"||command==="routing:unbind") {
    const status=await ownerControl("router",{action:"status"});
    if(command==="routing")console.log(JSON.stringify(status,null,2));
    else if(command==="routing:unbind")console.log(JSON.stringify(await ownerControl("router",{action:"unbind",expectedRevision:status.revision,taskScope:process.argv[3]}),null,2));
    else {
      const option=(name:string)=>{const index=process.argv.indexOf(name);const value=index>=0?process.argv[index+1]:undefined;if(index>=0&&(!value||value.startsWith("--")))throw new NativeRouteError("INVALID_ARGUMENT","Missing routing option value.");return value;};
      if(!["manual","sticky","priority","round_robin"].includes(process.argv[3]??""))throw new NativeRouteError("INVALID_ARGUMENT","Choose manual, sticky, priority or round_robin.");
      const names=option("--priority"),registry=getRegistry();
      const priority=names?names.split(",").map(name=>{const account=registry.find(name.trim());if(!account)throw new NativeRouteError("ACCOUNT_NOT_FOUND","Unknown routing priority account.",404);return account.accountId;}):[];
      const model=option("--model"),effort=option("--effort");
      const attempts=option("--max-attempts"),failoverDeadline=option("--failover-deadline-ms"),failover=process.argv.includes("--failover");
      if(!failover&&(attempts||failoverDeadline))throw new NativeRouteError("INVALID_ARGUMENT","Failover budgets require --failover.");
      if(effort&&!model)throw new NativeRouteError("INVALID_ARGUMENT","A routing effort requires --model.");
      console.log(JSON.stringify(await ownerControl("router",{action:"configure",expectedRevision:status.revision,settings:{mode:process.argv[3],priority,roundRobinOptIn:process.argv.includes("--round-robin-opt-in"),...(model?{modelSelection:{model,...(effort?{effort}:{})}}:{}),...(failover?{failover:{enabled:true,...(attempts?{maxAttempts:Number(attempts)}:{}),...(failoverDeadline?{deadlineMs:Number(failoverDeadline)}:{})}}:{})}}),null,2));
    }
  } else if(command==="receipt") {
    const requestId=process.argv[3];
    if(!requestId||!/^native_[a-f0-9]{64}$/.test(requestId))throw new NativeRouteError("INVALID_ARGUMENT","Use receipt <logical native_request_id>.");
    console.log(JSON.stringify(await ownerControl("reconcile",{requestId}),null,2));
  } else if (command === "resume") {
    const urlIndex = process.argv.indexOf("--url");
    console.log(JSON.stringify(await ownerControl("resume", process.argv.includes("--clear") ? { clear: true } : { url: urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined, nextTurn: process.argv.includes("--next-turn") }), null, 2));
  } else if (command === "start") {
    inspectIde(); assertNoLinks(nativeHome); fs.mkdirSync(nativeHome, { recursive: true });
    const registry = getRegistry();
    const controlToken = randomBytes(32).toString("hex");
    const cliPath = path.join(root, "packages/mcp-server/dist/cli.js");
    const backend = new NativeBrowserBackendPool(registry, cliPath);
    const proxy = await startNativeProxy({
      backend,
      accountRegistry: registry,
      knowledgeExperimental:process.env.AG_NATIVE_KNOWLEDGE_EXPERIMENTAL==="1",
      stateDirectory: nativeHome,
      controlToken,
      contextModelSelection: process.env.AG_NATIVE_CONTEXT_MODEL === "off" ? undefined : { model: process.env.AG_NATIVE_CONTEXT_MODEL ?? "3.8 Flash", ...(process.env.AG_NATIVE_CONTEXT_EFFORT ? { effort: process.env.AG_NATIVE_CONTEXT_EFFORT } : {}) },
      routingExperimental:process.env.AG_NATIVE_ROUTER_EXPERIMENTAL==="1",
      snapshotAttachment: process.env.AG_NATIVE_ATTACHMENT_TRANSPORT === "1",
      batchToolCalls: process.env.AG_NATIVE_BATCH_TOOL_CALLS === "1",
      stallTimeoutMs: Number(process.env.AG_NATIVE_STALL_TIMEOUT_MS ?? 300000),
      generationTimeoutMs: Number(process.env.AG_NATIVE_MAX_DURATION_MS ?? 1800000),
    });
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
    console.log(JSON.stringify({
      listening: endpoint,
      model: "Gemini Web (Local)",
      mode: "gemini_web",
      isolatedIdeProfile,
      activeAccount: registry.getActive()?.displayName,
      nativeInference: "unverified_until_live_acceptance",
    }));
  } else if (command === "launch") {
    const ide = inspectIde();
    configureIsolatedProfile(isolatedIdeProfile, endpoint);
    try { const status = await health(); if (status.runtimeRevision !== NATIVE_RUNTIME_REVISION) throw new NativeRouteError("RUNTIME_UPDATE_REQUIRED", "An older proxy is running. When idle, run npm run native:stop, then npm run native:launch."); }
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
    const browser = await ownerControl("browser");
    // Visible on purpose: the user needs to see this isolated IDE and complete its own login.
    const ideEnvironment = { ...process.env };
    delete ideEnvironment.ELECTRON_RUN_AS_NODE; delete ideEnvironment.NODE_OPTIONS;
    const child = spawn(ide.executable, ["--user-data-dir", isolatedIdeProfile, "--new-window", root], { detached: true, windowsHide: false, stdio: "ignore", env: ideEnvironment });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    console.log(JSON.stringify({ launchRequested: true, endpoint, isolatedIdeProfile, selectModel: "Gemini Web (Local)", browserState: browser.browserState, browserAccountState: browser.accountState, accountLogin: "Complete Google sign-in in the isolated IDE if requested.", browserLogin: "The isolated Gemini browser is opened automatically; sign in there if requested. Credentials are never copied." }, null, 2));
  } else throw new NativeRouteError("INVALID_COMMAND", "Use check, setup, start, launch, browser, status, accounts, accounts:status, account:add, account:use, account:disable, account:enable, account:check, account:verify, account:browser, routing, routing:set, routing:unbind, knowledge, knowledge:import, knowledge:register, knowledge:check, knowledge:refresh, knowledge:remove, knowledge:bind, knowledge:clear, imports:inspect, receipt, cancel, stop, resume or restore.");
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof NativeRouteError ? error.code : "NATIVE_COMMAND_FAILED", message: error instanceof NativeRouteError ? error.message : "Native route command failed; no credentials or source payload are logged." }));
  process.exitCode = 1;
}
