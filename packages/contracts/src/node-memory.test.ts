import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpNodeSemiSpace, mcpNodeMemoryArgs, McpNodeMemoryStatusSchema } from "./node-memory.js";

test("Node semi-space policy accepts only the measured finite choices and never arbitrary Node arguments", () => {
  for (const value of [undefined, "", "off"]) assert.equal(parseMcpNodeSemiSpace(value), null);
  assert.deepEqual(mcpNodeMemoryArgs(parseMcpNodeSemiSpace("8")), ["--max-semi-space-size=8"]);
  assert.deepEqual(mcpNodeMemoryArgs(parseMcpNodeSemiSpace("16")), ["--max-semi-space-size=16"]);
  assert.deepEqual(mcpNodeMemoryArgs(null), []);
  for (const value of ["32", "0", "-8", "8.0", " 8", "8 --inspect", "--require=anything"]) assert.throws(() => parseMcpNodeSemiSpace(value));
  assert.throws(() => mcpNodeMemoryArgs(32 as never));
});
test("Node policy diagnostics reject an applied claim that disagrees with the actual CLI setting", () => {
  const value = { scope: "shared_owner", pid: 123, requestedSemiSpaceMiB: 8, explicitCliSemiSpaceMiB: 8, status: "applied" };
  assert.equal(McpNodeMemoryStatusSchema.safeParse(value).success, true);
  assert.equal(McpNodeMemoryStatusSchema.safeParse({ ...value, explicitCliSemiSpaceMiB: 16 }).success, false);
  assert.equal(McpNodeMemoryStatusSchema.safeParse({ ...value, scope: "frontend" }).success, false);
  assert.equal(McpNodeMemoryStatusSchema.safeParse({ ...value, profilePath: "private" }).success, false);
  assert.equal(McpNodeMemoryStatusSchema.safeParse({ ...value, requestedSemiSpaceMiB: null, status: "not_requested" }).success, true);
});
