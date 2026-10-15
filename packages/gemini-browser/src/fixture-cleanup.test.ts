import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeFixtureProfile } from "./fixture-cleanup.js";

test("Fixture cleanup: persistent lock fails instead of silently passing", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const mocked = t.mock.method(fs, "rm", async () => { throw Object.assign(new Error("synthetic lock"), { code: "EPERM" }); });
  try { await assert.rejects(removeFixtureProfile(directory, 1), /cleanup failed/); }
  finally { mocked.mock.restore(); await removeFixtureProfile(directory); }
});
test("Fixture cleanup: unowned temp directory is never deleted", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "unowned-g4-profile-"));
  try {
    await assert.rejects(removeFixtureProfile(directory), /Invalid fixture cleanup target/);
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("unowned-g4-profile-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
