import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigTransactionService } from "./config-transaction.js";
import { type UiError } from "@antigravity-gemini-web/contracts";

function createSandbox(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-tx-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("config-tx-test-"));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
}

test("ConfigTransaction: preview -> apply -> restore on synthetic configuration file", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  const journalFile = path.join(sandbox, "config.journal.jsonl");

  fs.writeFileSync(configFile, JSON.stringify({
    revision: 1,
    "gemini.enabled": false,
    "editor.tabSize": 2,
  }, null, 2), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile, journalPath: journalFile });

  // 1. Preview
  const preview = await service.preview("modify", { "gemini.enabled": true, "gemini.shimPort": 9999 });
  assert.ok(preview.previewId);
  assert.equal(preview.action, "modify");
  assert.equal(preview.canApply, true);

  // 2. Apply with confirmation
  const applyResult = await service.apply(preview.previewId, { confirmed: true });
  assert.equal(applyResult.applied, true);
  assert.equal(applyResult.revision, 2);

  const appliedContent = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(appliedContent["gemini.enabled"], true);
  assert.equal(appliedContent["gemini.shimPort"], 9999);
  assert.equal(appliedContent["editor.tabSize"], 2);
  assert.equal(appliedContent.revision, 2);

  // 3. Restore
  const restoreResult = await service.restore(preview.previewId, { confirmed: true });
  assert.equal(restoreResult.restored, true);
  assert.equal(restoreResult.revision, 3);

  const restoredContent = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(restoredContent["gemini.enabled"], false);
  assert.equal(restoredContent["gemini.shimPort"], undefined);
  assert.equal(restoredContent["editor.tabSize"], 2);
});

test("ConfigTransaction: rejects preview, apply, and restore when a turn is active", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  fs.writeFileSync(configFile, JSON.stringify({ revision: 1 }), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile });

  await assert.rejects(
    service.preview("modify", { key: "val" }, { activeTurn: true }),
    (err: UiError) => err.code === "BUSY"
  );

  const preview = await service.preview("modify", { key: "val" });

  await assert.rejects(
    service.apply(preview.previewId, { confirmed: true, activeTurn: true }),
    (err: UiError) => err.code === "BUSY"
  );

  await service.apply(preview.previewId, { confirmed: true });

  await assert.rejects(
    service.restore(preview.previewId, { activeTurn: true }),
    (err: UiError) => err.code === "BUSY"
  );
});

test("ConfigTransaction: apply requires confirmation and rejects expired preview", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  fs.writeFileSync(configFile, JSON.stringify({ revision: 1 }), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile });

  const preview = await service.preview("modify", { key: "val" }, { ttlMs: 50 });

  // Missing confirmation
  await assert.rejects(
    service.apply(preview.previewId, { confirmed: false }),
    (err: UiError) => err.code === "CONFIRMATION_REQUIRED"
  );

  // Wait for expiry
  await new Promise(r => setTimeout(r, 60));

  await assert.rejects(
    service.apply(preview.previewId, { confirmed: true }),
    (err: UiError) => err.code === "TRANSACTION_EXPIRED"
  );
});

test("ConfigTransaction: external file modification between preview and apply triggers CONFIG_CONFLICT", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  fs.writeFileSync(configFile, JSON.stringify({ revision: 1, original: "initial" }), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile });
  const preview = await service.preview("modify", { modified: "value" });

  // External edit modifies file before apply
  fs.writeFileSync(configFile, JSON.stringify({ revision: 1, original: "tampered" }), "utf8");

  await assert.rejects(
    service.apply(preview.previewId, { confirmed: true }),
    (err: UiError) => err.code === "CONFIG_CONFLICT"
  );
});

test("ConfigTransaction: surgical rollback preserves unrelated external edits made after apply", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  fs.writeFileSync(configFile, JSON.stringify({
    revision: 1,
    "service.prop": "original",
    "unrelated.external": "untouched",
  }), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile });
  const preview = await service.preview("modify", {
    "service.prop": "service-updated",
    "service.newProp": "service-added",
  });

  await service.apply(preview.previewId, { confirmed: true });

  // While service change is applied, an external process adds/modifies other keys
  const diskContent = JSON.parse(fs.readFileSync(configFile, "utf8"));
  diskContent["user.customSetting"] = "custom-user-value";
  diskContent["unrelated.external"] = "user-edited";
  fs.writeFileSync(configFile, JSON.stringify(diskContent, null, 2), "utf8");

  // Rollback service changes
  await service.restore(preview.previewId, { confirmed: true });

  const restored = JSON.parse(fs.readFileSync(configFile, "utf8"));
  // Service-owned properties were restored
  assert.equal(restored["service.prop"], "original");
  assert.equal(restored["service.newProp"], undefined);
  // Unrelated external properties were completely preserved!
  assert.equal(restored["user.customSetting"], "custom-user-value");
  assert.equal(restored["unrelated.external"], "user-edited");
});

test("ConfigTransaction: journal logs redact sensitive secrets and keys", async (t) => {
  const sandbox = createSandbox(t);
  const configFile = path.join(sandbox, "synthetic-settings.json");
  const journalFile = path.join(sandbox, "config.journal.jsonl");

  fs.writeFileSync(configFile, JSON.stringify({ revision: 1 }), "utf8");

  const service = new ConfigTransactionService({ fixtureRoot: sandbox, configPath: configFile, journalPath: journalFile });
  const preview = await service.preview("modify", {
    "api.secretToken": "SUPER_SECRET_G4_TOKEN_VALUE",
    "user.password": "P@ssw0rd123!",
    "app.normalProp": "normal-value",
  });

  await service.apply(preview.previewId, { confirmed: true });
  await service.restore(preview.previewId, { confirmed: true });

  const journalLines = fs.readFileSync(journalFile, "utf8");
  assert.equal(journalLines.includes("SUPER_SECRET_G4_TOKEN_VALUE"), false);
  assert.equal(journalLines.includes("P@ssw0rd123!"), false);
  assert.ok(journalLines.includes("[REDACTED_KEY]"));
  assert.ok(journalLines.includes("app.normalProp"));
});

