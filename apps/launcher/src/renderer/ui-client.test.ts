import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLauncherClient, MOCK_SCENARIOS, getMockScenarioLabel, type MockScenarioId } from "./client/mock-client.js";
import { getPreloadClient, isPreloadAvailable } from "./client/preload-client.js";
import type { RuntimeEvent, RuntimeSnapshot } from "@antigravity-gemini-web/contracts";

test("G4-UI: Preload client strictly throws PRELOAD_UNAVAILABLE when preload is missing (no silent fallback to mock)", () => {
  assert.equal(isPreloadAvailable(), false);
  assert.throws(
    () => {
      getPreloadClient();
    },
    (err: any) => {
      assert.equal(err.code, "PRELOAD_UNAVAILABLE");
      return true;
    }
  );
});

test("G4-UI: Mock client correctly initializes and supports all 10 contract scenarios", async () => {
  const client = new MockLauncherClient("first_run");
  assert.equal(MOCK_SCENARIOS.length, 10);

  for (const s of MOCK_SCENARIOS) {
    client.setScenario(s.id);
    const snap = await client.getSnapshot();
    assert.equal(snap.schemaVersion, "0.1");
    assert.equal(snap.mode, "demo");

    if (s.id === "first_run") {
      assert.equal(snap.browser.state, "closed");
      assert.equal(snap.account.state, "unknown");
      assert.equal(snap.integration.state, "unverified");
    } else if (s.id === "login_required") {
      assert.equal(snap.browser.state, "needs_user_action");
      assert.equal(snap.account.state, "needs_user_action");
    } else if (s.id === "signed_in_route_unsupported") {
      assert.equal(snap.account.state, "signed_in");
      assert.equal(snap.integration.state, "unsupported");
    } else if (s.id === "turn_generating_tools") {
      assert.equal(snap.sessions.length, 1);
      assert.equal(snap.sessions[0].activeTurn?.state, "tool_running");
    } else if (s.id === "cancel_requested") {
      assert.equal(snap.sessions.length, 1);
      assert.equal(snap.sessions[0].activeTurn?.state, "cancel_requested");
      assert.equal(snap.sessions[0].activeTurn?.canCancel, false);
    } else if (s.id === "outcome_unknown_write") {
      assert.equal(snap.sessions.length, 1);
      assert.equal(snap.sessions[0].activeTurn?.state, "outcome_unknown");
      assert.equal(snap.sessions[0].lastOutcome, "outcome_unknown");
    }
  }
});

test("G4-UI: all scenario picker labels follow the saved VI/EN preference without changing scenario identity", async () => {
  const client = new MockLauncherClient("first_run");
  const initial = await client.getSnapshot();
  assert.deepEqual(MOCK_SCENARIOS.map(scenario => getMockScenarioLabel(scenario, initial.settings.language)), MOCK_SCENARIOS.map(scenario => scenario.label));

  await client.execute({ requestId: "picker-en", type: "settings.update", payload: { expectedRevision: initial.settings.revision, patch: { language: "en" } } });
  const english = await client.getSnapshot();
  const labels = MOCK_SCENARIOS.map(scenario => getMockScenarioLabel(scenario, english.settings.language));
  assert.equal(labels[0], "1. First run");
  assert.equal(labels[9], "10. Write outcome unknown");
  assert.equal(new Set(labels).size, 10);
  for (const [index, label] of labels.entries()) {
    assert.ok(label.trim().length > 0);
    assert.notEqual(label, MOCK_SCENARIOS[index].label);
  }
  assert.equal(client.currentScenario, "first_run");

  await client.execute({ requestId: "picker-vi", type: "settings.update", payload: { expectedRevision: english.settings.revision, patch: { language: "vi" } } });
  const vietnamese = await client.getSnapshot();
  assert.deepEqual(MOCK_SCENARIOS.map(scenario => getMockScenarioLabel(scenario, vietnamese.settings.language)), MOCK_SCENARIOS.map(scenario => scenario.label));
});

test("G4-UI: Mock client enforces capability gating on unverified commands", async () => {
  const client = new MockLauncherClient("first_run");

  // integration.apply rejected
  const ack1 = await client.execute({
    requestId: "mock-cmd-1",
    type: "integration.apply",
    payload: { previewId: "prev-1" },
  });
  assert.equal(ack1.accepted, false);
  assert.equal(ack1.error.code, "NATIVE_ROUTE_UNVERIFIED");

  // model.select rejected
  const ack2 = await client.execute({
    requestId: "mock-cmd-2",
    type: "model.select",
    payload: { modelId: "gemini-2.5-pro" },
  });
  assert.equal(ack2.accepted, false);
  assert.equal(ack2.error.code, "MODEL_UNAVAILABLE");

  // e2e check rejected
  const ack3 = await client.execute({
    requestId: "mock-cmd-3",
    type: "runtime.check",
    payload: { scope: "end_to_end" },
  });
  assert.equal(ack3.accepted, false);
  assert.equal(ack3.error.code, "NATIVE_ROUTE_UNVERIFIED");
});

test("G4-UI: Subscribe-before-snapshot and event delivery in mock client", async () => {
  const client = new MockLauncherClient("first_run");
  const received: RuntimeEvent[] = [];

  const unsubscribe = client.subscribe((evt) => {
    received.push(evt);
  });

  client.setScenario("turn_generating_tools");
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "snapshot.updated");
  const snap = (received[0].payload as any).snapshot as RuntimeSnapshot;
  assert.equal(snap.sessions[0].activeTurn?.state, "tool_running");

  unsubscribe();
  client.setScenario("first_run");
  // No further events received after unsubscribe
  assert.equal(received.length, 1);
});

test("G4-UI: Activity log filtering by severity and correlation ID support", async () => {
  const client = new MockLauncherClient("outcome_unknown_write");

  const allPage = await client.getActivity({});
  assert.ok(allPage.items.length >= 3);

  const errorPage = await client.getActivity({ severity: "error" });
  assert.ok(errorPage.items.every((a) => a.severity === "error"));

  const sessionPage = await client.getActivity({ sessionId: "syn-ws-1" });
  assert.ok(sessionPage.items.every((a) => a.sessionId === "syn-ws-1"));
});

