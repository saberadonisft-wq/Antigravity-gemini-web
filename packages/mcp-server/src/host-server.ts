import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HostTurnBroker, HostTool, Identity } from "./host-broker.js";
import { BridgeError } from "./service.js";

const capability = z.string().min(40).max(64);
function handler<T>(fn: (args: T) => unknown) {
  return async (args: T) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: error instanceof BridgeError ? error.code : "INVALID_ARGUMENT", message: error instanceof BridgeError ? error.message : "Host bridge rejected the request." }) }] }; }
  };
}
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// This server must only be connected to the IDE over its private stdio channel.
export function createHostServer(broker: HostTurnBroker) {
  let ownedTask: string | undefined;
  const owned = (taskId: string) => { if (ownedTask !== taskId) throw new BridgeError("STALE_AUTHORITY", "This MCP connection does not own the host task."); };
  const server = new McpServer({ name: "gemini-ide-host", version: "0.1.0" }, {
    instructions: "Host-side tool pump. Begin only a user-authorized task, supply the exact native tool inventory and workspace, and pass the returned turn_token to the Gemini custom MCP conversation. Poll ide_host_next. Execute an action at most once with the native IDE tool and its ordinary approvals after verifying workspace and arguments; report its actual result with ide_host_result. Never synthesize success or bypass approvals. awaiting_result means the action was already claimed: do not execute it again. This pump still uses the host agent; native model replacement is unverified.",
  });
  server.registerTool("ide_host_begin", { description: "Create one time-limited host task binding and web turn capability. Only advertise tools this IDE task actually owns. Does not start a Gemini conversation.", inputSchema: { task_id: Identity, workspace_id: z.string().min(1).max(1024), tools: z.array(HostTool).min(1).max(32), ttl_ms: z.number().int().min(1000).max(900000).default(300000) }, annotations: write }, handler(args => { const task = broker.begin(args.task_id, args.workspace_id, args.tools, args.ttl_ms); ownedTask = task.taskId; return task; }));
  server.registerTool("ide_host_next", { description: "Claim the next action once. Execute with native approvals, then report the result. Retrying after delivery never returns the action for execution again. Poll waiting with a bounded pause.", inputSchema: { task_id: Identity }, annotations: { ...write, idempotentHint: false } }, handler(args => { owned(args.task_id); return broker.next(args.task_id); }));
  server.registerTool("ide_host_result", { description: "Report the real result of a claimed native tool. Result and failure status are immutable. Never claim a tool ran when it did not.", inputSchema: { task_id: Identity, call_id: Identity, result: z.unknown(), is_error: z.boolean() }, annotations: write }, handler(args => { owned(args.task_id); return broker.finishAction(args.task_id, args.call_id, args.result, args.is_error); }));
  server.registerTool("ide_host_abort", { description: "Retire the host task capability and fence pending actions. Does not undo or kill a native side effect already executing.", inputSchema: { task_id: Identity }, annotations: write }, handler(args => { owned(args.task_id); return broker.abort(args.task_id); }));
  server.server.onclose = () => { if (ownedTask) { try { broker.abort(ownedTask); } catch {} } };
  return server;
}

// Public/remote-facing tools only. No host_begin, host_next or host_result methods exist here.
export function createWebHostServer(broker: HostTurnBroker) {
  const server = new McpServer({ name: "gemini-ide-tools", version: "0.1.0" }, {
    instructions: "Use only the current host-provided turn_token. Discover ide_tool_inventory, enqueue a call with ide_tool_call, and poll ide_tool_result with the same call_id until completed. pending does not mean the action ran. The IDE agent executes requested tools under its own approvals. Never reuse call IDs for different actions or retry an uncertain side effect. Complete with ide_turn_complete only when host results are settled.",
  });
  server.registerTool("ide_tool_inventory", { description: "List only the tools bound to this host task and its workspace.", inputSchema: { turn_token: capability }, annotations: read }, handler(args => broker.inventory(args.turn_token)));
  server.registerTool("ide_tool_call", { description: "Queue an allowlisted native IDE action. This can request file changes or commands if the host inventory permits them; native approvals still apply. Returns pending until host executes. Reuse the same call_id when retrying the same action.", inputSchema: { turn_token: capability, call_id: Identity, tool: z.string().min(1).max(96), arguments: z.record(z.unknown()) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } }, handler(args => broker.enqueue(args.turn_token, args.call_id, args.tool, args.arguments)));
  server.registerTool("ide_tool_result", { description: "Read the actual host tool result. Unknown or interrupted outcomes must not trigger a resend.", inputSchema: { turn_token: capability, call_id: Identity }, annotations: read }, handler(args => broker.callResult(args.turn_token, args.call_id)));
  server.registerTool("ide_turn_complete", { description: "Publish the final answer back to the bound IDE task after all tool results are settled.", inputSchema: { turn_token: capability, final_text: z.string().max(65536) }, annotations: write }, handler(args => broker.complete(args.turn_token, args.final_text)));
  return server;
}
