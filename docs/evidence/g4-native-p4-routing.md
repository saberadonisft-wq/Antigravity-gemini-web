# P4 — Experimental account admission and parallel routing

Original milestone: 2026-10-17, native revision 27 / browser worker 19. Follow-up on 2026-10-18: source 31 / worker 22 implements finite no-Send failover and durable attempt history; see [failover evidence](g4-native-p4-failover.md). P4 remains IN PROGRESS. The live owner remains revision 29/manual while the user completes Google traffic verification; automatic routing and failover are off. The revision-27 behavior and validation below are historical.

## Implemented behavior

- Manual remains the default and preserves the user's current Web model unless an explicit model policy is configured. It never switches to another account when the selected account is unavailable.
- Sticky, priority and round robin require `AG_NATIVE_ROUTER_EXPERIMENTAL=1` and one explicit model/effort policy. Round robin additionally requires `roundRobinOptIn`. Known-unavailable observations are scoped by account identity epoch and model. Unknown capability is verified by the existing exact model-selection checks before Send; it is not advertised as verified availability.
- Each account has one active lease. One IDE task cannot acquire a second concurrent lease, including on another account. Independent tasks can occupy separate workers. HTTP retries of the same logical request still share its result/pending turn.
- Sticky bindings and round-robin cursor are committed only after source context and the logical request have been reserved. Rejected/previously fenced requests cannot create phantom sticky bindings. Binding identity epochs persist across restart; changed epochs require explicit unbind/recovery rather than automatic reassignment.
- Config changes use an owner-authenticated endpoint, strict schemas, revision compare-and-set and a private writer lock. No binding is silently evicted at capacity. A configured automatic mode with its runtime flag removed fails closed rather than silently switching policy.
- Round-robin order is stable across global account-selection changes. Disabled, unregistered, busy or recently observed-unavailable accounts are excluded. Manual selection allows immediate explicit rechecking after an observed failure; generic Web errors never become quota/cooldown evidence.
- The account snapshot selected by the router must match the configuration bound by the backend pool. An external registry edit between those steps is rejected before browser work. Subsequent async checkpoints still verify the captured account configuration.
- Cancellation can finish the HTTP response before the backend settles. The account lease remains occupied until backend settlement, and late submission/physical-reservation callbacks are rejected. No unconfirmed outcome is retried or failed over.
- Conversation retirement is routed to its known owner. Cleanup of a busy owner is deferred and drained on that account; another worker is not disturbed. MCP reports pending browser operations as busy and ignores release of unknown keys without touching an active conversation.

This is account admission and routing, not failover. Every attempted request still has at most one selected account. Observed eligibility affects a later independent admission; it does not cause the failed request to be resent.

## Controls

`npm run native -- routing` reads settings, revision, bindings and active leases. The settings live in `routing.json`; only hashes/IDs and routing metadata are stored.

Examples for an explicitly enabled experimental runtime, using names from the actual Web picker:

```powershell
npm run native -- routing:set priority --model 'Exact Web model' --effort 'Exact effort' --priority 'Default Account,Secondary Account'
npm run native -- routing:set sticky --model 'Exact Web model'
npm run native -- routing:set round_robin --model 'Exact Web model' --round-robin-opt-in
npm run native -- routing:unbind '<64_hex_task_scope>'
npm run native -- routing:set manual
```

These are configuration examples, not evidence that these models exist on an account. The automatic-mode commands are rejected by the currently running default owner because its experiment flag is off. They do not silently change the Web model to a fallback.

## Evidence and validation

[Priority routing fixture](mcp/native-p4-priority-routing-fixture.json) uses real loopback HTTP, actual MCP services and SQLite, with synthetic browser/model behavior. A and B each received exactly one synthetic Send concurrently. A duplicate request coalesced, another turn in A's IDE chat was rejected, and restart/account switching did not replay the old request. An unavailable synthetic model was rejected before Send without falling through to another account. This is not two-account Gemini Web acceptance or IDE execution.

- Workspace build PASS: `.tmp/p4-router-build-verified.log`.
- Native 103/103 PASS: `.tmp/p4-router-native-verified.log`, including six router-policy cases, seven HTTP/pool cases, post-cancel lease retention, stale callbacks and the registry-selection race.
- MCP 45/45 PASS: `.tmp/p4-router-mcp-final.log`, including busy-profile cleanup/readiness, physical-store migration and 2,100-request/restart coverage.
- Contracts 8/8 PASS: `.tmp/p4-router-contracts.log`. Total in these three packages: 156. The browser package was unchanged; its prior P3 run is not counted as a fresh run here.
- Workspace typecheck PASS: `.tmp/p4-router-typecheck.log`.
- Initial native run failed two positive mock scenarios that omitted registered fingerprints (`.tmp/p4-router-native-initial.log`). Those fixtures now enroll their identities as the production contract requires. A new HTTP negative case verifies that unenrolled identities are rejected before backend work; error expectations were not relaxed.

The coordinator/SQLite fixture does not test real browser-model availability, Google limits, two real signed-in profiles, source editing by the IDE executor, desktop launcher controls or remote CI.

## Live owner boundary

Before reload, revision 26 was idle. The isolated profile had one app tab, no generation or draft, and one MCP peer belonging to the native process. The ordinary owner CLI stopped it; its owned worker PID 14812 exited before the new runtime started. No foreign worker was killed.

Revision 27 / PID 7364 started normally. Default Account was verified at 2026-10-17T04:30:11Z with `promptSent:false`. [Read-only live inspection](mcp/native-r27-ledger-live-inspection.json) confirmed worker 19's fingerprint, manual mode, automatic routing off, upload off, and preservation of all 135 real legacy receipts in SQLite. This verifies loading and metadata/identity readiness, not live inference or automatic routing acceptance.

The earlier compound-command review rejection did not recur for these ordinary owner CLI operations. The previously stopped owner and later idle-owned reload were handled as separate, observed lifecycle changes.

## Remaining P4 scope

Finite budgets, durable attempt histories and trusted not_sent failover are implemented and fixture-validated in source 31; [details and limits](g4-native-p4-failover.md). Real sticky/priority/round-robin and failover acceptance with two signed-in Web profiles remains open, along with IDE execution and soak/recovery/rollback gates. No ACK error, generic Web error, lost acknowledgement, cancellation uncertainty or identity drift after Send authorizes another account attempt. P1/P2, P3 and P5–P8 gates remain open.
