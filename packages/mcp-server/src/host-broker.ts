import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { BridgeError } from "./service.js";

export const HostTool = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,96}$/), description: z.string().max(1000), inputSchema: z.record(z.unknown()) }).strict();
export const Identity = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/);
export type HostInventory = z.infer<typeof HostTool>[];
type Call = { callId: string; tool: string; arguments: Record<string, unknown>; hash: string; state: "queued" | "delivered" | "completed"; result?: unknown; isError?: boolean };
type Task = { taskId: string; token: string; workspaceId: string; inventory: HostInventory; validators: Map<string, (value: unknown) => { valid: boolean }>; expires: number; state: "active" | "completed" | "interrupted"; calls: Map<string, Call>; finalText?: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

/** Routes messages only. The broker never reads files, applies patches or executes a shell.
 * The local IDE agent performs each allowed action with its own native tool/approval flow.
 * Web clients cannot reach host-side methods through the web MCP server.
 */
export class HostTurnBroker {
  private task?: Task;
  private retired = new Set<string>();
  constructor(private readonly now = () => Date.now(), private readonly reserveIdentity?: (taskId: string, workspaceId: string) => void) {}
  begin(taskId: string, workspaceId: string, inventory: HostInventory, ttlMs: number) {
    Identity.parse(taskId);
    if (this.retired.has(taskId) || this.task?.taskId === taskId) throw new BridgeError("CONFIG_CONFLICT", "Task identity cannot be reused.");
    if (this.task?.state === "active" && this.task.expires > this.now()) throw new BridgeError("BUSY", "Another host task owns this broker.");
    if (this.retired.size >= 2048) throw new BridgeError("QUEUE_FULL", "Task identity capacity reached.");
    if (this.task) this.retired.add(this.task.taskId);
    const tools = z.array(HostTool).min(1).max(32).parse(inventory);
    if (new Set(tools.map(t => t.name)).size !== tools.length || JSON.stringify(tools).length > 32768) throw new BridgeError("INVALID_ARGUMENT", "Tool inventory must be unique and bounded.");
    const validators: Task["validators"] = new Map();
    try {
      const validator = new AjvJsonSchemaValidator();
      for (const tool of tools) {
        if (tool.inputSchema.type !== "object") throw Error("Tool inputs must be objects");
        validators.set(tool.name, validator.getValidator(tool.inputSchema));
      }
    } catch { throw new BridgeError("INVALID_ARGUMENT", "Host tool schemas cannot be compiled."); }
    if (!workspaceId || workspaceId.length > 1024) throw new BridgeError("INVALID_ARGUMENT", "Workspace binding is required.");
    this.reserveIdentity?.(taskId, workspaceId);
    this.task = { taskId, token: randomBytes(32).toString("base64url"), workspaceId, inventory: structuredClone(tools), validators, expires: this.now() + Math.min(900000, Math.max(1000, ttlMs)), state: "active", calls: new Map() };
    return { taskId, turn_token: this.task.token, workspaceId, tools, expiresAt: new Date(this.task.expires).toISOString(), execution: "host_agent_native_tools", nativeInference: "unverified" };
  }
  private current(taskId?: string) {
    if (!this.task || (taskId && taskId !== this.task.taskId)) throw new BridgeError("STALE_AUTHORITY", "Host task does not match the current authority.");
    if (this.task.expires <= this.now()) { if (this.task.state === "active") this.task.state = "interrupted"; throw new BridgeError("STALE_AUTHORITY", "Turn capability expired; pending actions must not be replayed."); }
    return this.task;
  }
  private web(token: string) {
    // Tokens have fixed length; compare digests to avoid data-dependent prefix checks.
    const task = this.current();
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(task.token).digest())) throw new BridgeError("STALE_AUTHORITY", "Invalid turn capability.");
    return task;
  }
  inventory(token: string) {
    const task = this.web(token);
    if (task.state !== "active") throw new BridgeError("STALE_AUTHORITY", "Turn is terminal.");
    return { taskId: task.taskId, workspaceId: task.workspaceId, tools: structuredClone(task.inventory) };
  }
  enqueue(token: string, callId: string, tool: string, args: Record<string, unknown>) {
    const task = this.web(token); Identity.parse(callId);
    if (task.state !== "active") throw new BridgeError("STALE_AUTHORITY", "Turn is terminal.");
    if (!task.inventory.some(t => t.name === tool)) throw new BridgeError("TOOL_DENIED", "Tool is not in this host turn's inventory.");
    if (JSON.stringify(args).length > 32768) throw new BridgeError("CONTEXT_TOO_LARGE", "Tool arguments exceed the bridge limit.");
    if (!task.validators.get(tool)!(args).valid) throw new BridgeError("TOOL_DENIED", "Tool arguments do not match the host schema.");
    const hash = createHash("sha256").update(canonical({ tool, args })).digest("hex");
    const existing = task.calls.get(callId);
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError("CONFIG_CONFLICT", "Call ID is already bound to different arguments.");
      return this.callResult(token, callId);
    }
    if (task.calls.size >= 32) throw new BridgeError("QUEUE_FULL", "Turn tool budget exhausted.");
    if ([...task.calls.values()].some(c => c.state !== "completed")) throw new BridgeError("BUSY", "Wait for the active host tool before submitting another action.");
    task.calls.set(callId, { callId, hash, tool, arguments: structuredClone(args), state: "queued" });
    return { callId, status: "pending", execution: "not_started" };
  }
  callResult(token: string, callId: string) {
    const task = this.web(token);
    const call = task.calls.get(callId);
    if (!call) throw new BridgeError("REQUEST_NOT_FOUND", "Unknown host tool call.");
    if (task.state === "interrupted" && call.state !== "completed") throw new BridgeError("OUTCOME_UNKNOWN", "Host turn was interrupted. Do not execute or replay pending actions.");
    return call.state === "completed" ? { callId, status: "completed", result: structuredClone(call.result), isError: call.isError } : { callId, status: "pending", execution: call.state === "delivered" ? "host_claimed" : "not_started" };
  }
  next(taskId: string) {
    const task = this.current(taskId);
    if (task.state !== "active") return { taskId, status: task.state, finalText: task.finalText };
    const delivered = [...task.calls.values()].find(c => c.state === "delivered");
    // An unacknowledged native side effect is never handed out a second time.
    if (delivered) return { taskId, status: "awaiting_result", callId: delivered.callId };
    const queued = [...task.calls.values()].find(c => c.state === "queued");
    if (!queued) return { taskId, status: "waiting" };
    queued.state = "delivered";
    return { taskId, status: "action", callId: queued.callId, workspaceId: task.workspaceId, tool: queued.tool, arguments: structuredClone(queued.arguments), mustUseNativeApprovals: true };
  }
  finishAction(taskId: string, callId: string, result: unknown, isError: boolean) {
    const task = this.current(taskId);
    if (task.state !== "active") throw new BridgeError("STALE_AUTHORITY", "Host task is terminal.");
    const call = task.calls.get(callId);
    if (!call || call.state === "queued") throw new BridgeError("STALE_AUTHORITY", "Host has not claimed this action.");
    if (JSON.stringify(result).length > 65536) throw new BridgeError("CONTEXT_TOO_LARGE", "Tool result exceeds the bridge limit.");
    if (call.state === "completed") {
      if (canonical(call.result) !== canonical(result) || call.isError !== isError) throw new BridgeError("CONFIG_CONFLICT", "Tool result is terminal and immutable.");
      return { callId, accepted: true };
    }
    call.state = "completed"; call.result = structuredClone(result); call.isError = isError;
    return { callId, accepted: true };
  }
  complete(token: string, finalText: string) {
    const task = this.web(token);
    if (task.state === "completed" && task.finalText === finalText) return { completed: true };
    if (task.state !== "active") throw new BridgeError("STALE_AUTHORITY", "Task is terminal.");
    if ([...task.calls.values()].some(c => c.state !== "completed")) throw new BridgeError("BUSY", "Host actions are still pending.");
    if (finalText.length > 65536) throw new BridgeError("CONTEXT_TOO_LARGE", "Final answer exceeds bridge limit.");
    task.state = "completed"; task.finalText = finalText;
    return { completed: true };
  }
  abort(taskId?: string) {
    if (!this.task) return { interrupted: false };
    if (taskId && taskId !== this.task.taskId) throw new BridgeError("STALE_AUTHORITY", "Wrong host task.");
    if (this.task.state === "active") this.task.state = "interrupted";
    return { interrupted: this.task.state === "interrupted" };
  }
}
