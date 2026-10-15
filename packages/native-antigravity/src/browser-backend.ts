import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NativeRouteError, object, type JsonObject } from "./native-protocol.js";

export interface NativeBrowserBackend {
  generate(requestId: string, prompt: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
  openBrowser?(): Promise<JsonObject>;
}
/** Reuse the existing singleton browser owner, not a second Chrome/profile controller. */
export class McpNativeBrowserBackend implements NativeBrowserBackend {
  private client = new Client({ name: "gemini-native-provider", version: "0.1.0" });
  private connection?: Promise<void>;
  constructor(private readonly cliPath: string) {}
  private connect(): Promise<void> {
    return this.connection ??= this.client.connect(new StdioClientTransport({
      command: process.execPath, args: [this.cliPath], stderr: "pipe",
      env: { AG_MCP_TARGET_CLIENT: "any" },
    })).then(() => undefined);
  }
  private async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 25000 });
    const content = result.content as Array<{ type: string; text?: string }>;
    let value: unknown;
    try { value = JSON.parse(content.find(part => part.type === "text")?.text ?? ""); } catch {}
    if (!object(value)) throw new NativeRouteError("BROWSER_PROTOCOL_ERROR", "Browser broker returned an invalid result.", 502);
    if (result.isError) throw new NativeRouteError(typeof value.code === "string" ? value.code : "BROWSER_UNAVAILABLE", "Browser broker rejected the native request. Inspect browser status; do not resend uncertain requests.", 503);
    return value;
  }
  async openBrowser() {
    await this.connect();
    return this.call("gemini_open_browser", {});
  }
  async generate(requestId: string, prompt: string, signal: AbortSignal): Promise<string> {
    await this.connect();
    signal.throwIfAborted();
    const status = await this.call("gemini_status", {}, signal);
    if (status.browserState !== "ready" || status.accountState !== "signed_in") throw new NativeRouteError("BROWSER_NOT_READY", "Open the existing Gemini Web browser and sign in before using this native model.", 503);
    if (typeof status.maxPromptChars !== "number" || status.maxPromptChars < prompt.length || status.freshConversationSupported !== true) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh the browser MCP runtime to load native provider transport and fresh conversation support.", 503);
    // Once submit has started, an abort is an uncertain acceptance; cancel uses the same request ID.
    const cancel = () => { void this.call("gemini_cancel", { request_id: requestId }).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      await this.call("gemini_submit", { request_id: requestId, prompt, fresh_conversation: true }, signal);
      while (!signal.aborted) {
        const response = await this.call("gemini_result", { request_id: requestId, wait_ms: 5000 }, signal);
        if (response.status === "completed" && typeof response.text === "string") {
          if (Array.isArray(response.codeBlocks) && response.codeBlocks.length) {
            if (response.codeBlocks.length !== 1 || typeof response.codeBlocks[0] !== "string") throw new NativeRouteError("AMBIGUOUS_MODEL_REPLY", "Native response contains multiple code blocks.", 502);
            return response.codeBlocks[0];
          }
          return response.text;
        }
        if (response.status !== "pending") throw new NativeRouteError("BROWSER_TURN_FAILED", "Gemini Web did not complete the native request. No model fallback or automatic resend.", 502);
      }
      signal.throwIfAborted();
      throw new NativeRouteError("CANCELLED", "Native request cancelled.", 499);
    } finally { signal.removeEventListener("abort", cancel); }
  }
  async close() { await this.client.close(); }
}
