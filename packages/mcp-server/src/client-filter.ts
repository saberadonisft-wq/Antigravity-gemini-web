import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Ancestor = { name: string };
export function classifyMcpClient(ancestors: Ancestor[]): "antigravity_ide" | "agy" | "other" {
  // A native IDE can itself launch agy. Prefer the native ancestor over an intermediate helper.
  if (ancestors.some(p => p.name.toLowerCase() === "antigravity ide.exe")) return "antigravity_ide";
  if (ancestors.some(p => p.name.toLowerCase() === "agy.exe")) return "agy";
  return "other";
}

export function clientPolicyAllows(policy: string, ancestors: Ancestor[]) {
  if (policy === "any") return true;
  if (policy === "disabled") return false;
  if (policy !== "antigravity_ide") throw Error("Invalid AG_MCP_TARGET_CLIENT. Use any, antigravity_ide or disabled.");
  return classifyMcpClient(ancestors) === "antigravity_ide";
}

async function ancestors(): Promise<Ancestor[]> {
  if (process.platform !== "win32") return [];
  // Read executable names only. Command lines can contain credentials and are not needed here.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $taskMap = @{}
    foreach ($taskProcess in @(Get-CimInstance Win32_Process)) { $taskMap[[int]$taskProcess.ProcessId] = $taskProcess }
    $taskNext = [int]$env:AG_MCP_PARENT_PID
    $taskResult = @()
    $taskSeen = @{}
    for ($taskIndex = 0; $taskIndex -lt 16; $taskIndex++) {
      if ($taskNext -le 0 -or $taskSeen.ContainsKey($taskNext) -or -not $taskMap.ContainsKey($taskNext)) { break }
      $taskSeen[$taskNext] = $true
      $taskProcess = $taskMap[$taskNext]
      $taskResult += @{ name = [string]$taskProcess.Name }
      $taskNext = [int]$taskProcess.ParentProcessId
    }
    ConvertTo-Json -InputObject @($taskResult) -Compress
  `;
  try {
    const result = await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 3000, maxBuffer: 16384, env: { ...process.env, AG_MCP_PARENT_PID: String(process.ppid) } });
    const value: unknown = JSON.parse(result.stdout.trim());
    if (!Array.isArray(value) || value.length > 16 || value.some(p => !p || typeof p.name !== "string")) return [];
    return value;
  } catch { return []; }
}

/** Routing convenience for a shared config file, not an authentication/security boundary. */
export async function isMcpClientAllowed(): Promise<boolean> {
  const policy = process.env.AG_MCP_TARGET_CLIENT ?? "any";
  if (policy !== "antigravity_ide") return clientPolicyAllows(policy, []);
  return clientPolicyAllows(policy, await ancestors());
}

/** An excluded app gets an honest, initialized zero-tool server rather than an ownership/EOF error. */
export async function serveFilteredClient(name: string) {
  const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: {} }, instructions: "This MCP entry is restricted by AG_MCP_TARGET_CLIENT. No tools or browser/task resources are available to this client. The configured target is Antigravity IDE; use its MCP panel, or explicitly change the client policy before using another host. This is client routing, not a connected browser or native inference route." });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  let finish!: () => void;
  const ended = new Promise<void>(resolve => { finish = resolve; });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    void server.close().then(finish, finish);
  };
  server.onclose = close;
  process.stdin.once("end", close); process.stdin.once("close", close);
  process.once("SIGINT", close); process.once("SIGTERM", close);
  await server.connect(new StdioServerTransport());
  await ended;
}
