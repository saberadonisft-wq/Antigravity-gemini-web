import { z } from "zod";

/** Startup semi-space tuning only; this is not a total Node/Chrome RAM limit. */
export const McpNodeSemiSpaceSchema = z.union([z.literal(8), z.literal(16)]).nullable();
export type McpNodeSemiSpace = z.infer<typeof McpNodeSemiSpaceSchema>;
export function parseMcpNodeSemiSpace(value: string | undefined): McpNodeSemiSpace {
  if (value === undefined || value === "" || value === "off") return null;
  if (value === "8") return 8;
  if (value === "16") return 16;
  throw Error("AG_MCP_NODE_SEMI_SPACE_MB must be off, 8, or 16.");
}
export function mcpNodeMemoryArgs(value: McpNodeSemiSpace): string[] {
  const policy = McpNodeSemiSpaceSchema.parse(value);
  return policy === null ? [] : [`--max-semi-space-size=${policy}`];
}
export const McpNodeMemoryStatusSchema = z.object({
  scope: z.literal("shared_owner"), pid: z.number().int().positive(),
  requestedSemiSpaceMiB: McpNodeSemiSpaceSchema,
  explicitCliSemiSpaceMiB: z.number().int().positive().max(2147483647).nullable(),
  status: z.enum(["not_requested", "applied", "mismatch"]),
}).strict().superRefine((value, context) => {
  const expected = value.requestedSemiSpaceMiB === null ? "not_requested" : value.explicitCliSemiSpaceMiB === value.requestedSemiSpaceMiB ? "applied" : "mismatch";
  if (value.status !== expected) context.addIssue({ code: z.ZodIssueCode.custom, message: "Node startup policy diagnostics are inconsistent." });
});
