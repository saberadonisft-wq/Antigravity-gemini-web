import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeRuntimeEngine,
  InProcessLauncherClient,
  getStoragePaths,
  assertNoPathOverlap,
} from "./index.js";
import { LiveNativeAntigravityAdapter } from "@antigravity-gemini-web/native-antigravity";
import { LiveGeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import type { ControlCommand, RuntimeEvent, CommandAck } from "@antigravity-gemini-web/contracts";

test("Behavior 1: Invalid schema, bad commands, and version mismatch are rejected", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  // Rejects invalid command structure
  await assert.rejects(async () => {
    await client.execute({
      requestId: "req-bad",
      type: "invalid.type" as any,
      payload: {},
    });
  });

  // Rejects bad payload type
  await assert.rejects(async () => {
    await client.execute({
      requestId: "req-bad-2",
      type: "runtime.check",
      payload: { scope: "invalid_scope" as any },
    });
  });
});

test("Behavior 2 [F2 Regression]: Deduplication compares command type and canonical payload, rejects conflicts", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  const command: ControlCommand = {
    requestId: "req-concurrent-1",
    type: "browser.open",
    payload: {},
  };

  // Run two concurrent commands with the same requestId and same payload
  const [ack1, ack2] = await Promise.all([
    client.execute(command),
    client.execute(command),
  ]);

  assert.equal(ack1.accepted, true);
  assert.equal(ack2.accepted, true);
  if (ack1.accepted && ack2.accepted) {
    assert.equal(ack1.operationId, ack2.operationId);
  }

  // Idempotent replay after completion
  const ackReplay = await client.execute(command);
  assert.equal(ackReplay.accepted, true);
  if (ack1.accepted && ackReplay.accepted) {
    assert.equal(ackReplay.operationId, ack1.operationId);
  }

  // Same requestId with DIFFERENT command type (both have payload: {}) MUST reject with CONFIG_CONFLICT [F2 regression]
  const differentTypeCommand: ControlCommand = {
    requestId: "req-concurrent-1",
    type: "account.check",
    payload: {},
  };
  const ackDiffType = await client.execute(differentTypeCommand);
  assert.equal(ackDiffType.accepted, false);
  if (!ackDiffType.accepted) {
    assert.equal(ackDiffType.error.code, "CONFIG_CONFLICT");
  }

  // Concurrent conflicting commands MUST reject with CONFIG_CONFLICT [F2 regression]
  const p1 = client.execute({
    requestId: "req-concurrent-conflict",
    type: "runtime.check",
    payload: { scope: "connection" },
  });
  const p2 = client.execute({
    requestId: "req-concurrent-conflict",
    type: "runtime.check",
    payload: { scope: "end_to_end" },
  });
  const [res1, res2] = await Promise.all([p1, p2]);
  const hasConflict = (!res1.accepted && res1.error.code === "CONFIG_CONFLICT") ||
                      (!res2.accepted && res2.error.code === "CONFIG_CONFLICT");
  assert.ok(hasConflict, "At least one concurrent conflicting request must be rejected with CONFIG_CONFLICT");
});

test("Behavior 2b: Settings update rejects stale revisions and accepts valid revisions", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  const snapshot = await client.getSnapshot();
  const currentRev = snapshot.settings.revision;

  // Stale revision rejection
  const staleAck = await client.execute({
    requestId: "req-settings-stale",
    type: "settings.update",
    payload: {
      expectedRevision: currentRev + 10,
      patch: { theme: "dark" },
    },
  });
  assert.equal(staleAck.accepted, false);
  if (!staleAck.accepted) {
    assert.equal(staleAck.error.code, "CONFIG_CONFLICT");
  }

  // Valid revision update succeeds
  const validAck = await client.execute({
    requestId: "req-settings-valid",
    type: "settings.update",
    payload: {
      expectedRevision: currentRev,
      patch: { theme: "dark" },
    },
  });
  assert.equal(validAck.accepted, true);

  const updatedSnapshot = await client.getSnapshot();
  assert.equal(updatedSnapshot.settings.theme, "dark");
  assert.equal(updatedSnapshot.settings.revision, currentRev + 1);
});

test("Behavior 3: Cancel command does not transition to terminal early; outcome unknown is terminal", async () => {
  const engine = new FakeRuntimeEngine("generating", "demo");
  const client = new InProcessLauncherClient(engine);

  const initialSnapshot = await client.getSnapshot();
  const session = initialSnapshot.sessions[0];
  assert.ok(session);
  assert.ok(session.activeTurn);
  assert.equal(session.activeTurn.state, "generating");

  // Send turn.cancel
  const cancelAck = await client.execute({
    requestId: "req-cancel-1",
    type: "turn.cancel",
    payload: {
      sessionId: session.id,
      turnId: session.activeTurn.id,
    },
  });
  assert.equal(cancelAck.accepted, true);

  // Turn must be in non-terminal cancel_requested, NOT terminal cancelled!
  const afterCancelSnapshot = await client.getSnapshot();
  const updatedTurn = afterCancelSnapshot.sessions[0]?.activeTurn;
  assert.ok(updatedTurn);
  assert.equal(updatedTurn.state, "cancel_requested");
  assert.equal(updatedTurn.canCancel, false);

  // Test outcome_unknown scenario
  engine.switchScenario("outcome_unknown");
  const outcomeSnapshot = await client.getSnapshot();
  assert.equal(outcomeSnapshot.sessions[0]?.lastOutcome, "outcome_unknown");
  assert.equal(outcomeSnapshot.sessions[0]?.activeTurn?.state, "outcome_unknown");
});

test("Behavior 4 [F3 Regression]: Multiple subscribers both receive events independently via fan-out", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  const sub1Events: RuntimeEvent[] = [];
  const sub2Events: RuntimeEvent[] = [];

  const unsub1 = client.subscribe((e) => sub1Events.push(e));
  const unsub2 = client.subscribe((e) => sub2Events.push(e));

  // Execute a command that emits events
  await client.execute({
    requestId: "req-sub-test",
    type: "browser.open",
    payload: {},
  });

  // BOTH subscribers must receive all emitted events [F3 regression fix]
  assert.ok(sub1Events.length > 0, "Subscriber 1 should receive events");
  assert.equal(sub1Events.length, sub2Events.length, "Subscriber 2 must receive the exact same events as subscriber 1");
  assert.equal(sub1Events[0]?.id, sub2Events[0]?.id);

  unsub1();
  unsub2();
});

test("Behavior 4b: Sequence gaps and restarts trigger snapshot resync callbacks", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  let resyncCount = 0;
  client.onResyncNeeded(() => {
    resyncCount += 1;
  });

  const unsub = client.subscribe(() => {});
  await client.getSnapshot();

  // Gap triggers resync
  engine.simulateEventGap();
  assert.equal(resyncCount, 1);

  // Restart triggers resync
  engine.simulateRestart();
  assert.equal(resyncCount, 2);

  unsub();
});

test("Behavior 5 [F8 Regression]: Path separation enforces canonical equality and containment checks", () => {
  const devPaths = getStoragePaths("demo");
  const livePaths = getStoragePaths("live");

  assert.notEqual(devPaths.appDataDir, livePaths.appDataDir);
  assert.notEqual(devPaths.browserProfileDir, livePaths.browserProfileDir);
  assert.notEqual(devPaths.configFilePath, livePaths.configFilePath);

  assert.doesNotThrow(() => {
    assertNoPathOverlap(devPaths, livePaths);
  });

  // Containment violation must be detected [F8 regression]
  const overlappingPaths = {
    mode: "demo" as const,
    appDataDir: "C:\\Users\\test\\.gemini\\antigravity-gemini-web-live\\subfolder",
    browserProfileDir: "C:\\temp\\browser",
    configFilePath: "C:\\temp\\config.json",
  };
  const liveTargetPaths = {
    mode: "live" as const,
    appDataDir: "C:\\Users\\test\\.gemini\\antigravity-gemini-web-live",
    browserProfileDir: "C:\\Users\\test\\.gemini\\antigravity-gemini-web-live\\browser_profile",
    configFilePath: "C:\\Users\\test\\.gemini\\antigravity-gemini-web-live\\config.json",
  };

  assert.throws(() => {
    assertNoPathOverlap(overlappingPaths, liveTargetPaths);
  });
});

test("Behavior 6: Live adapters never produce fake success and maintain unverified state", { timeout: 60000 }, async (t) => {
  const nativeAdapter = new LiveNativeAntigravityAdapter();
  const status = await nativeAdapter.checkStatus();
  assert.equal(status.state, "unverified");
  assert.equal(status.capability.state, "unverified");

  await assert.rejects(async () => {
    await nativeAdapter.applyBridge("prev-test");
  });

  // Controlled closed driver configuration with non-existent binary and unused port
  const browserAdapter = new LiveGeminiBrowserAdapter({
    chromePath: "C:\\non-existent-chrome-path\\chrome.exe",
    debugPort: 59998,
  });
  t.after(async () => {
    await browserAdapter.cleanup();
  });

  const bStatus = await browserAdapter.checkStatus();
  assert.equal(bStatus.accountState, "unknown");

  const openRes = await browserAdapter.openBrowser();
  assert.equal(openRes.opened, false);

  await assert.rejects(async () => {
    await browserAdapter.sendPrompt("test prompt");
  });
});

test("Behavior 7 [F1 Regression]: Live runtime mode delegates to live adapter and rejects fake success", { timeout: 60000 }, async (t) => {
  const closedBrowserAdapter = new LiveGeminiBrowserAdapter({
    chromePath: "C:\\non-existent-chrome-path\\chrome.exe",
    debugPort: 59997,
  });
  t.after(async () => {
    await closedBrowserAdapter.cleanup();
  });

  const liveEngine = new FakeRuntimeEngine("first_run", "live", { liveBrowserAdapter: closedBrowserAdapter });
  const client = new InProcessLauncherClient(liveEngine);

  // browser.open in live mode must NOT set state to ready [F1 regression]
  const openAck = await client.execute({
    requestId: "req-live-open",
    type: "browser.open",
    payload: {},
  });
  assert.equal(openAck.accepted, false);
  if (!openAck.accepted) {
    assert.equal(openAck.error.code, "BROWSER_USER_ACTION_REQUIRED");
  }

  // account.check in live mode must NOT claim signed_in or Demo User [F1 regression]
  const accountAck = await client.execute({
    requestId: "req-live-account",
    type: "account.check",
    payload: {},
  });
  assert.equal(accountAck.accepted, false);
  if (!accountAck.accepted) {
    assert.equal(accountAck.error.code, "LOGIN_REQUIRED");
  }

  const liveSnapshot = await client.getSnapshot();
  assert.notEqual(liveSnapshot.account.state, "signed_in");
  assert.notEqual(liveSnapshot.browser.state, "ready");

  // integration.apply in live mode is rejected
  const applyAck = await client.execute({
    requestId: "req-live-apply",
    type: "integration.apply",
    payload: { previewId: "prev-123" },
  });
  assert.equal(applyAck.accepted, false);
  if (!applyAck.accepted) {
    assert.equal(applyAck.error.code, "NATIVE_ROUTE_UNVERIFIED");
  }
});

test("Behavior 8 [F5 Regression]: Snapshot sequence matches event sequence and revision increments on changes", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  let capturedSnapshotInEvent: any = null;
  let capturedEventSequence = -1;

  const unsub = client.subscribe((event) => {
    if (event.type === "snapshot.updated") {
      capturedSnapshotInEvent = event.payload.snapshot;
      capturedEventSequence = event.sequence;
    }
  });

  const snapBefore = await client.getSnapshot();
  const revBefore = snapBefore.revision;

  await client.execute({
    requestId: "req-seq-test",
    type: "browser.open",
    payload: {},
  });

  assert.ok(capturedSnapshotInEvent);
  // Watermark check: snapshot inside snapshot.updated MUST match event.sequence [F5 regression]
  assert.equal(capturedSnapshotInEvent.lastEventSequence, capturedEventSequence);
  // Revision must have incremented
  assert.equal(capturedSnapshotInEvent.revision, revBefore + 1);

  unsub();
});

test("Behavior 9 [R1 Regression]: Canonical recursive fingerprinting preserves nested payload differences and sorts keys", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  const snap = await client.getSnapshot();
  const rev = snap.settings.revision;

  // First settings update with theme: dark
  const ack1 = await client.execute({
    requestId: "req-r1-test",
    type: "settings.update",
    payload: {
      expectedRevision: rev,
      patch: { theme: "dark" },
    },
  });
  assert.equal(ack1.accepted, true);

  // Same requestId with different nested payload (theme: light) MUST CONFLICT [R1 regression]
  const ackConflict = await client.execute({
    requestId: "req-r1-test",
    type: "settings.update",
    payload: {
      expectedRevision: rev,
      patch: { theme: "light" },
    },
  });
  assert.equal(ackConflict.accepted, false);
  if (!ackConflict.accepted) {
    assert.equal(ackConflict.error.code, "CONFIG_CONFLICT");
  }

  // Different key ordering in nested payload must produce same canonical fingerprint and deduplicate
  const ackReordered1 = await client.execute({
    requestId: "req-r1-reorder",
    type: "settings.update",
    payload: {
      expectedRevision: rev + 1,
      patch: { theme: "system", language: "vi" },
    },
  });
  assert.equal(ackReordered1.accepted, true);

  // Replay with reversed keys in patch object
  const ackReordered2 = await client.execute({
    requestId: "req-r1-reorder",
    type: "settings.update",
    payload: {
      patch: { language: "vi", theme: "system" },
      expectedRevision: rev + 1,
    },
  });
  assert.equal(ackReordered2.accepted, true);
  if (ackReordered1.accepted && ackReordered2.accepted) {
    assert.equal(ackReordered1.operationId, ackReordered2.operationId);
  }
});

test("Behavior 10 [R2 Regression]: Early in-flight promise reservation prevents reentrant duplicate execution", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  let reentrantAck: CommandAck | undefined;
  let reentrantExecutionAttempted = false;

  const targetCommand: ControlCommand = {
    requestId: "req-r2-reentrant",
    type: "browser.open",
    payload: {},
  };

  // Subscriber that reentrantly calls execute with the exact same command during operation.updated
  const unsub = client.subscribe((event) => {
    if (event.type === "operation.updated" && !reentrantExecutionAttempted) {
      reentrantExecutionAttempted = true;
      // Reentrant execution of the identical in-flight command
      client.execute(targetCommand).then((ack) => {
        reentrantAck = ack;
      });
    }
  });

  const mainAck = await client.execute(targetCommand);
  assert.equal(mainAck.accepted, true);

  // Wait for tick to ensure subscriber promise resolved
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(reentrantAck !== undefined);
  const reAck = reentrantAck as CommandAck;
  assert.equal(reAck.accepted, true);
  if (mainAck.accepted && reAck.accepted) {
    assert.equal(mainAck.operationId, reAck.operationId);
  }

  unsub();
});

test("Behavior 11 [R3 Regression]: Live runtime diagnostic, preview, and export reject fake success and require real execution", async () => {
  const engine = new FakeRuntimeEngine("first_run", "live");
  const client = new InProcessLauncherClient(engine);

  const initialSnap = await client.getSnapshot();
  // Initial snapshot in live mode must NOT have demo checks [R3 regression]
  assert.equal(initialSnap.lastCheck, null);

  // 1. live runtime.check with scope end_to_end must fail with NATIVE_ROUTE_UNVERIFIED
  const checkAck = await client.execute({
    requestId: "req-r3-check",
    type: "runtime.check",
    payload: { scope: "end_to_end" },
  });
  assert.equal(checkAck.accepted, false);
  if (!checkAck.accepted) {
    assert.equal(checkAck.error.code, "NATIVE_ROUTE_UNVERIFIED");
  }

  // 2. live integration.preview must fail with NATIVE_ROUTE_UNVERIFIED
  const prevAck = await client.execute({
    requestId: "req-r3-preview",
    type: "integration.preview",
    payload: { action: "install" },
  });
  assert.equal(prevAck.accepted, false);
  if (!prevAck.accepted) {
    assert.equal(prevAck.error.code, "NATIVE_ROUTE_UNVERIFIED");
  }

  // 3. live activity.export must fail with SERVICE_UNAVAILABLE
  const expAck = await client.execute({
    requestId: "req-r3-export",
    type: "activity.export",
    payload: { range: "current_session" },
  });
  assert.equal(expAck.accepted, false);
  if (!expAck.accepted) {
    assert.equal(expAck.error.code, "SERVICE_UNAVAILABLE");
  }
});

test("Behavior 12 [R4 Regression]: Terminal turn is immutable; cancel on missing, stale, or terminal turn is rejected", async () => {
  const engine = new FakeRuntimeEngine("outcome_unknown", "demo");
  const client = new InProcessLauncherClient(engine);

  const snap = await client.getSnapshot();
  const session = snap.sessions[0];
  assert.ok(session);
  assert.ok(session.activeTurn);
  assert.equal(session.activeTurn.state, "outcome_unknown");

  // 1. Attempt to cancel a terminal turn (outcome_unknown) MUST be rejected with TURN_TERMINAL [R4 regression]
  const termCancelAck = await client.execute({
    requestId: "req-r4-cancel-term",
    type: "turn.cancel",
    payload: {
      sessionId: session.id,
      turnId: session.activeTurn.id,
    },
  });
  assert.equal(termCancelAck.accepted, false);
  if (!termCancelAck.accepted) {
    assert.equal(termCancelAck.error.code, "TURN_TERMINAL");
  }

  // Verify terminal turn state was NOT altered
  const snapAfter = await client.getSnapshot();
  assert.equal(snapAfter.sessions[0]?.activeTurn?.state, "outcome_unknown");

  // 2. Attempt to cancel non-existent session
  const nonExistAck = await client.execute({
    requestId: "req-r4-cancel-bad-sess",
    type: "turn.cancel",
    payload: {
      sessionId: "sess-non-existent",
      turnId: "turn-123",
    },
  });
  assert.equal(nonExistAck.accepted, false);
  if (!nonExistAck.accepted) {
    assert.equal(nonExistAck.error.code, "SESSION_NOT_FOUND");
  }
});

test("Behavior 13 [R5 Regression]: Late events from retired runtime instances are rejected and do not trigger reverse resync", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  const initialSnap = await client.getSnapshot();
  const oldInstanceId = initialSnap.runtimeInstanceId;

  let resyncCallCount = 0;
  client.onResyncNeeded(() => {
    resyncCallCount += 1;
  });

  const receivedEvents: any[] = [];
  client.subscribe((e) => receivedEvents.push(e));

  // Restart engine to new instance
  const newInstanceId = engine.simulateRestart();
  assert.notEqual(oldInstanceId, newInstanceId);

  // Client gets update for new instance (resync triggered once for restart)
  const snapAfterRestart = await client.getSnapshot();
  assert.equal(snapAfterRestart.runtimeInstanceId, newInstanceId);
  const resyncCountAfterRestart = resyncCallCount;

  // Now simulate late event delivered from the OLD retired instance
  const lateOldEvent = {
    schemaVersion: "0.1",
    runtimeInstanceId: oldInstanceId,
    sequence: 99,
    id: "evt-late-old",
    occurredAt: new Date().toISOString(),
    type: "activity.appended",
    payload: {
      entry: {
        id: "act-late",
        at: new Date().toISOString(),
        severity: "info",
        category: "late",
        summary: "Late event from retired instance",
      },
    },
  };

  // Feed late event through engine subscriber directly
  for (const sub of (engine as any).subscribers) {
    sub(lateOldEvent);
  }

  // The late event MUST be dropped: receivedEvents must not contain evt-late-old
  const hasLateOldEvent = receivedEvents.some((e) => e.id === "evt-late-old");
  assert.equal(hasLateOldEvent, false, "Late event from retired instance must be dropped!");

  // Resync count must NOT have increased (no reverse resync)
  assert.equal(resyncCallCount, resyncCountAfterRestart);
});

test("Behavior 14 [A1 Regression]: Leader-only and concurrent command failures do not produce unhandled promise rejections and allow clean retries", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => {
    unhandled.push(err);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    // 1. Leader-only failure
    const originalProcess = (engine as any).processCommand.bind(engine);
    (engine as any).processCommand = async () => {
      throw new Error("Synthetic processCommand failure for A1 test");
    };

    let caughtErr: Error | null = null;
    try {
      await engine.execute({
        requestId: "req-a1-leader-fail",
        type: "browser.open",
        payload: {},
      });
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Caller should catch the command failure");
    assert.equal(caughtErr.message, "Synthetic processCommand failure for A1 test");

    // Wait a tick to ensure no unhandledRejection is triggered in the background
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, "No unhandledRejection should be emitted for leader-only failure!");

    // Verify inFlightMap is cleaned up and retry is possible
    assert.equal((engine as any).inFlightMap.has("req-a1-leader-fail"), false);

    // 2. Concurrent failure: Leader and Waiter
    let waiterCaught: Error | null = null;
    let leaderCaught: Error | null = null;

    const p1 = engine.execute({
      requestId: "req-a1-concurrent-fail",
      type: "browser.open",
      payload: {},
    }).catch((e) => { leaderCaught = e; });

    const p2 = engine.execute({
      requestId: "req-a1-concurrent-fail",
      type: "browser.open",
      payload: {},
    }).catch((e) => { waiterCaught = e; });

    await Promise.all([p1, p2]);

    assert.ok(leaderCaught, "Leader should catch rejection");
    assert.ok(waiterCaught, "Concurrent waiter should catch rejection");
    assert.equal((engine as any).inFlightMap.has("req-a1-concurrent-fail"), false, "inFlightMap cleaned up");

    // Restore original processCommand
    (engine as any).processCommand = originalProcess;

    // Retry after failure must succeed
    const retryAck = await engine.execute({
      requestId: "req-a1-leader-fail",
      type: "browser.open",
      payload: {},
    });
    assert.equal(retryAck.accepted, true, "Retry after failure must be accepted cleanly");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, "Zero unhandled rejections across all scenarios!");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("Behavior 15 [A2 Regression]: Asynchronous resync buffers events across delayed snapshots, epoch changes, and listener unsubscribe", async () => {
  const engine = new FakeRuntimeEngine("first_run", "demo");
  const client = new InProcessLauncherClient(engine);

  await client.getSnapshot();

  const receivedEvents: RuntimeEvent[] = [];
  const unsubListener1 = client.subscribe((e) => receivedEvents.push(e));

  // 1. Asynchronous delayed snapshot during gap
  let resyncStarted = false;
  let resyncCompleted = false;

  client.onResyncNeeded(async () => {
    resyncStarted = true;
    // Delay before fetching snapshot
    await new Promise((r) => setTimeout(r, 50));
    await client.getSnapshot();
    resyncCompleted = true;
  });

  // Trigger gap: engine advances sequence by 5 and emits event
  engine.simulateEventGap();
  assert.equal(resyncStarted, true, "Resync callback should be triggered immediately");

  // While resync snapshot is delayed, emit additional events
  engine.recordActivity("info", "test", "Buffered event 1 while resyncing");
  engine.recordActivity("info", "test", "Buffered event 2 while resyncing");

  // Wait for the async resync to complete
  await client.waitForResync();
  assert.equal(resyncCompleted, true, "Resync should complete authoritatively");

  // The authoritative snapshot covers the buffered events; they must not be replayed again.
  assert.equal(receivedEvents.length, 0, "Events already covered by the snapshot watermark must be dropped");

  // 2. Unsubscribe during resync
  const unsubsEvents: RuntimeEvent[] = [];
  const unsubListener2 = client.subscribe((e) => unsubsEvents.push(e));

  // Trigger another gap
  engine.simulateEventGap();
  // Unsubscribe listener2 while resync might be buffering/in progress
  unsubListener2();

  engine.recordActivity("info", "test", "Event after listener 2 unsubscribed");
  await client.waitForResync();

  // listener2 must not have received new events after unsubscribing
  const hasEventAfterUnsub = unsubsEvents.some((e) => (e.payload as any)?.entry?.summary === "Event after listener 2 unsubscribed");
  assert.equal(hasEventAfterUnsub, false, "Unsubscribed listener must not receive replayed buffered events");

  unsubListener1();
});


