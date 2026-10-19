// Test entry only: verify the actual frontend and bootstrap owner arguments.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMcpNodeSemiSpace } from "@antigravity-gemini-web/contracts";
import { assertNodeMemoryStartup } from "../node-memory.js";

const root = fs.realpathSync(path.dirname(process.env.AG_MCP_BROWSER_PROFILE!));
assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
assert.match(path.basename(root), /^gemini-mcp-test-native-memory-/);
const policy = parseMcpNodeSemiSpace(process.env.AG_MCP_NODE_SEMI_SPACE_MB);
assert.equal(policy, 8);
assertNodeMemoryStartup(policy);
await import("../cli.js");
