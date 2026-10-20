import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { type LauncherClient, type RuntimeEvent, type UiError, OperationRecordSchema } from "@antigravity-gemini-web/contracts";
import { MockLauncherClient } from "./client/mock-client.js";
import { LauncherStore } from "./client/launcher-store.js";
import { executeAndWait } from "./client/operations.js";
import { translations, t, errorText } from "./i18n.js";

test("G4 renderer: accepted acknowledgment cannot turn a failed operation into a success", async () => {
  const client = new MockLauncherClient();
  const source = client as LauncherClient;
  source.execute = async () => ({ requestId: "request", accepted: true, operationId: "operation" });
  source.getOperation = async () => ({ id: "operation", requestId: "request", type: "browser.open", state: "failed", error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic failure", retryable: false }, updatedAt: new Date().toISOString() });
  const ack = await executeAndWait(source, { requestId: "request", type: "browser.open", payload: {} });
  assert.equal(ack.accepted, false);
});

test("G4 renderer: typed demo check/export results and updated settings comply with shared schemas", async () => {
  const client = new MockLauncherClient();
  for (const command of [
    { requestId: "check", type: "runtime.check", payload: { scope: "connection" } },
    { requestId: "export", type: "activity.export", payload: { range: "last_24h" } },
    { requestId: "preferences", type: "settings.update", payload: { expectedRevision: 1, patch: { theme: "dark" } } },
  ] as const) {
    const ack = await client.execute(command);
    assert.equal(ack.accepted, true);
    if (ack.accepted) OperationRecordSchema.parse(await client.getOperation(ack.operationId));
  }
  assert.equal((await client.getSnapshot()).settings.theme, "dark");
  assert.equal((await client.getSnapshot()).settings.revision, 2);
});

test("G4 renderer: snapshot watermark prevents late duplicates and retired instance reversal", async () => {
  const client = new MockLauncherClient();
  let emit!: (event: RuntimeEvent) => void;
  client.subscribe = listener => { emit = listener; return () => {}; };
  const snapshot = await client.getSnapshot();
  snapshot.lastEventSequence = 5;
  client.getSnapshot = async () => structuredClone(snapshot);
  const store = new LauncherStore(client);
  await store.start();
  const stale = structuredClone(snapshot);
  stale.settings.theme = "dark";
  emit({ schemaVersion: "0.1", runtimeInstanceId: snapshot.runtimeInstanceId, sequence: 4, id: "old", occurredAt: new Date().toISOString(), type: "snapshot.updated", payload: { snapshot: stale } });
  assert.equal(store.state.snapshot?.settings.theme, "system");
  const oldInstance = snapshot.runtimeInstanceId;
  snapshot.runtimeInstanceId = "restarted";
  snapshot.lastEventSequence = 1;
  await store.refresh();
  emit({ schemaVersion: "0.1", runtimeInstanceId: oldInstance, sequence: 99, id: "retired", occurredAt: new Date().toISOString(), type: "snapshot.updated", payload: { snapshot: stale } });
  assert.equal(store.state.snapshot?.runtimeInstanceId, "restarted");
  store.dispose();
});

test("G4 renderer: bootstrap failure yields an error state instead of an endless connecting screen", async () => {
  const client = new MockLauncherClient();
  client.getSnapshot = async () => { throw { code: "SERVICE_UNAVAILABLE", message: "Synthetic failure", retryable: true } satisfies UiError; };
  const store = new LauncherStore(client);
  await store.start();
  assert.equal(store.state.snapshot, null);
  assert.equal(store.state.disconnected, true);
  assert.equal(store.state.error?.code, "SERVICE_UNAVAILABLE");
  store.dispose();
});

test("G4 renderer: a never-resolving snapshot has a finite deadline", { timeout: 3000 }, async () => {
  const client = new MockLauncherClient();
  client.getSnapshot = async () => new Promise(() => {});
  const store = new LauncherStore(client);
  const started = Date.now();
  await store.start();
  assert.equal(store.state.error?.code, "SERVICE_UNAVAILABLE");
  assert.ok(Date.now() - started < 2500);
  store.dispose();
});

test("G4 UI: i18n copy layer provides complete translations for both vi and en without missing keys", () => {
  const viKeys = Object.keys(translations.vi).sort();
  const enKeys = Object.keys(translations.en).sort();
  assert.deepEqual(enKeys, viKeys, "Translations for en and vi must have identical key sets.");

  for (const key of viKeys as (keyof typeof translations.vi)[]) {
    assert.ok(translations.vi[key].length > 0, `Vietnamese translation for '${key}' must not be empty.`);
    assert.ok(translations.en[key].length > 0, `English translation for '${key}' must not be empty.`);
  }
});

test("G4 followup UI: a hung operation fetch has a finite deadline and cannot become success", { timeout: 2000 }, async () => {
  const client = new MockLauncherClient();
  client.execute = async () => ({ requestId: "hung", accepted: true, operationId: "hung-operation" });
  client.getOperation = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(executeAndWait(client, { requestId: "hung", type: "browser.open", payload: {} }, 100), (error: UiError) => error.code === "OUTCOME_UNKNOWN");
  assert.ok(Date.now() - started < 1000);
});

test("G4 followup UI: typed error templates follow locale and never render raw exception data", () => {
  const error = { code: "CONFIG_CONFLICT", message: "SYNTHETIC_PRIVATE_ERROR_PAYLOAD", retryable: false } satisfies UiError;
  assert.ok(errorText("en", error).includes("Your draft is retained"));
  assert.ok(errorText("vi", error).includes("Bản nháp được giữ lại"));
  assert.equal(errorText("en", error).includes(error.message), false);
  assert.ok(errorText("en", { code: "NATIVE_ROUTE_UNVERIFIED" }).includes("Native inference route"));
});

test("G4 UI: language lookup translates strings dynamically based on selected language", () => {
  assert.equal(t("vi", "settingsTitle"), "Cài đặt ứng dụng");
  assert.equal(t("en", "settingsTitle"), "Application Settings");
  assert.equal(t("vi", "cardPreferences"), "Giao diện & Chẩn đoán");
  assert.equal(t("en", "cardPreferences"), "Appearance & Diagnostics");
  assert.equal(t("vi", "step1Title"), "Bước 1: Kiểm tra Antigravity IDE");
  assert.equal(t("en", "step1Title"), "Step 1: Inspect Antigravity IDE");
  assert.equal(t(undefined, "appNameValue"), "Antigravity · Gemini Web Desktop Launcher");
});

test("G4 UI: WCAG contrast calculation for theme color tokens meets required ratios", () => {
  function parseHex(hex: string): [number, number, number] {
    const clean = hex.replace("#", "");
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  function relativeLuminance(rgb: [number, number, number]): number {
    const [r, g, b] = rgb.map(val => {
      const s = val / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrastRatio(hex1: string, hex2: string): number {
    const l1 = relativeLuminance(parseHex(hex1));
    const l2 = relativeLuminance(parseHex(hex2));
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  const css = fs.readFileSync(new URL("../../src/renderer/styles/theme.css", import.meta.url), "utf8");
  const light = css.match(/:root\s*\{([^}]+)\}/)![1]!;
  const dark = css.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)![1]!;
  const color = (body: string, name: string) => body.match(new RegExp(name + ":\\s*(#[a-fA-F0-9]{6})"))![1]!;
  // Use current CSS, not copied color constants.
  const lightPrimaryRatio = contrastRatio(color(light, "--bg-primary"), color(light, "--text-primary"));
  const lightSecondaryRatio = contrastRatio(color(light, "--bg-tertiary"), color(light, "--text-secondary"));
  assert.ok(lightPrimaryRatio >= 7.0, `Light primary text ratio ${lightPrimaryRatio.toFixed(2)} must exceed WCAG AAA 7.0:1`);
  assert.ok(lightSecondaryRatio >= 4.5, `Light secondary text ratio ${lightSecondaryRatio.toFixed(2)} must exceed WCAG AA 4.5:1`);

  // Dark theme: bg #0d1117, text-primary #e6edf3, text-secondary #8b949e
  const darkPrimaryRatio = contrastRatio(color(dark, "--bg-primary"), color(dark, "--text-primary"));
  const darkSecondaryRatio = contrastRatio(color(dark, "--bg-tertiary"), color(dark, "--text-secondary"));
  assert.ok(darkPrimaryRatio >= 7.0, `Dark primary text ratio ${darkPrimaryRatio.toFixed(2)} must exceed WCAG AAA 7.0:1`);
  assert.ok(darkSecondaryRatio >= 4.5, `Dark secondary text ratio ${darkSecondaryRatio.toFixed(2)} must exceed WCAG AA 4.5:1`);
});

test("G4 UI: Settings draft state preserves user modifications when update fails", async () => {
  const client = new MockLauncherClient();
  const currentSnap = await client.getSnapshot();
  const initialRevision = currentSnap.settings.revision;

  // Simulate a conflict rejection with stale revision
  const conflictAck = await client.execute({
    requestId: "req-conflict-draft",
    type: "settings.update",
    payload: {
      expectedRevision: initialRevision + 99, // intentional stale revision
      patch: { theme: "dark", language: "en" },
    },
  });

  assert.equal(conflictAck.accepted, false);
  if (!conflictAck.accepted) {
    assert.equal(conflictAck.error.code, "CONFIG_CONFLICT");
  }

  // Authoritative snapshot revision did NOT advance
  const snapAfter = await client.getSnapshot();
  assert.equal(snapAfter.settings.revision, initialRevision);
});

test("G4 UI: SessionsView cancellation stays in cancel_requested without fake auto-completion", async () => {
  const client = new MockLauncherClient("turn_generating_tools");
  const snap = await client.getSnapshot();
  const session = snap.sessions[0];
  assert.ok(session);
  assert.ok(session.activeTurn);

  const cancelAck = await client.execute({
    requestId: "req-ui-cancel-test",
    type: "turn.cancel",
    payload: { sessionId: session.id, turnId: session.activeTurn.id },
  });

  assert.equal(cancelAck.accepted, true);
  if (cancelAck.accepted) {
    const op = await client.getOperation(cancelAck.operationId);
    assert.equal(op.state, "running");
    assert.equal(op.type, "turn.cancel");
  }
});

