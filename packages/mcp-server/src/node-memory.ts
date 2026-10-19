import { McpNodeMemoryStatusSchema, McpNodeSemiSpaceSchema, type McpNodeSemiSpace } from "@antigravity-gemini-web/contracts";

export function describeNodeMemoryPolicy(requested: McpNodeSemiSpace, argv = process.execArgv) {
  McpNodeSemiSpaceSchema.parse(requested);
  let explicitCliSemiSpaceMiB: number | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index].replaceAll("_", "-");
    const inline = /^--max-semi-space-size=(\d+)$/.exec(arg);
    const value = inline?.[1] ?? (arg === "--max-semi-space-size" ? argv[index + 1] : undefined);
    if (value && /^\d+$/.test(value)) explicitCliSemiSpaceMiB = Number(value);
  }
  return McpNodeMemoryStatusSchema.parse({
    scope: "shared_owner", pid: process.pid, requestedSemiSpaceMiB: requested, explicitCliSemiSpaceMiB,
    status: requested === null ? "not_requested" : explicitCliSemiSpaceMiB === requested ? "applied" : "mismatch",
  });
}
export function assertNodeMemoryStartup(requested: McpNodeSemiSpace) {
  if (describeNodeMemoryPolicy(requested).status === "mismatch") throw Error("Requested Node semi-space policy did not reach the shared owner; no browser runtime was created.");
}
