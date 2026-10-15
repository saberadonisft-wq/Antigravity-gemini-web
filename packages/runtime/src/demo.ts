import { MockLauncherClient } from "./mock-client.js";

async function main() {
  console.log("=================================================");
  console.log("Antigravity-gemini-web: G1 Mock Runtime Harness");
  console.log("=================================================");

  const client = new MockLauncherClient("first_run");
  console.log(`[Status] Banner: "${client.demoBanner}"`);

  // 1. Subscribe to events
  const unsubscribe = client.subscribe((event) => {
    console.log(`[Event #${event.sequence}] Type: ${event.type} (Occurred: ${event.occurredAt})`);
  });

  // 2. Fetch initial snapshot
  const initialSnapshot = await client.getSnapshot();
  console.log(`[Snapshot] Instance: ${initialSnapshot.runtimeInstanceId}, Revision: ${initialSnapshot.revision}`);
  console.log(`[Snapshot] Integration: ${initialSnapshot.integration.state}, NativeRoute Capability: ${initialSnapshot.capabilities.nativeRoute?.state}`);
  console.log(`[Snapshot] Account: ${initialSnapshot.account.state}, Browser: ${initialSnapshot.browser.state}`);

  // 3. Execute command: browser.open
  console.log("\n--- Executing browser.open ---");
  const ack1 = await client.execute({
    requestId: "req-demo-1",
    type: "browser.open",
    payload: {},
  });
  console.log(`[CommandAck] Accepted: ${ack1.accepted}, OperationId: ${ack1.accepted ? ack1.operationId : "N/A"}`);

  // 4. Test Deduplication
  console.log("\n--- Testing Deduplication: Exact same requestId and payload ---");
  const ackDedupe = await client.execute({
    requestId: "req-demo-1",
    type: "browser.open",
    payload: {},
  });
  console.log(`[CommandAck] Deduplicated Accepted: ${ackDedupe.accepted}, OperationId matches: ${ackDedupe.accepted && ack1.accepted && ackDedupe.operationId === ack1.operationId}`);

  console.log("\n--- Testing Deduplication: Same requestId with conflicting payload ---");
  const ackConflict = await client.execute({
    requestId: "req-demo-1",
    type: "runtime.check",
    payload: { scope: "connection" },
  });
  console.log(`[CommandAck] Conflict Rejected: ${!ackConflict.accepted}, Error: ${!ackConflict.accepted ? ackConflict.error.code : "none"}`);

  // 5. Test Settings Revision check
  console.log("\n--- Testing Settings Update: Stale revision rejection ---");
  const snapshotBeforeSettings = await client.getSnapshot();
  const ackStaleSettings = await client.execute({
    requestId: "req-settings-stale",
    type: "settings.update",
    payload: {
      expectedRevision: snapshotBeforeSettings.settings.revision + 99, // Intentional stale revision
      patch: { theme: "dark" },
    },
  });
  console.log(`[CommandAck] Stale Settings Rejected: ${!ackStaleSettings.accepted}, Error: ${!ackStaleSettings.accepted ? ackStaleSettings.error.code : "none"}`);

  console.log("\n--- Testing Settings Update: Valid revision ---");
  const ackValidSettings = await client.execute({
    requestId: "req-settings-valid",
    type: "settings.update",
    payload: {
      expectedRevision: snapshotBeforeSettings.settings.revision,
      patch: { theme: "dark" },
    },
  });
  console.log(`[CommandAck] Valid Settings Accepted: ${ackValidSettings.accepted}`);

  // 6. Switch Scenario to cancel_pending
  console.log("\n--- Switching scenario to cancel_pending ---");
  client.switchScenario("cancel_pending");
  const cancelSnapshot = await client.getSnapshot();
  const activeTurn = cancelSnapshot.sessions[0]?.activeTurn;
  console.log(`[Scenario: cancel_pending] Turn state: ${activeTurn?.state}, canCancel: ${activeTurn?.canCancel}`);

  // 7. Query Activity Log
  console.log("\n--- Querying Activity Log ---");
  const activityPage = await client.getActivity({ limit: 5 });
  console.log(`[Activity Log] Retrieved ${activityPage.items.length} entries:`);
  for (const entry of activityPage.items) {
    console.log(`  - [${entry.severity.toUpperCase()}] ${entry.category}: ${entry.summary}`);
  }

  unsubscribe();
  console.log("\n[Done] Demo completed cleanly.");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
