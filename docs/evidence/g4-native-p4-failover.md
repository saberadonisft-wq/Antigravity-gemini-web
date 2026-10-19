# P4 — Finite account failover before Send

Date: 2026-10-18. Source: native revision 31 / browser worker 22. Implementation and isolated integration checks pass; real two-account Gemini Web and IDE executor acceptance remain pending. P4 is IN PROGRESS. Automatic routing and failover remain disabled in the main owner (revision 29), whose browser is being kept open for user traffic verification.

## Policy and boundaries

- Manual remains the default. Failover requires the existing experimental router runtime flag, an automatic mode, an explicit fixed processing model policy, and `failover.enabled=true`. Explicit Web conversation resume remains pinned to its original account and never enables failover.
- Default budget is two distinct accounts within 60 seconds; configuration permits two to four accounts and 1–120 seconds. This deadline limits starting another account attempt; it does not extend the normal generation timeout. Both a monotonic timer and the persisted wall-clock deadline must allow the transition.
- Only a locally structured `NativeRouteError` with `delivery=not_sent`, an allowed pre-Send phase and an eligible code permits handoff: BUSY, MODEL_UNAVAILABLE, BROWSER_LOGIN_REQUIRED, ACCOUNT_IDENTITY_UNVERIFIED or ACCOUNT_IDENTITY_CHANGED. Generic objects/model prose, Google verification, timeout, cancellation, lost acknowledgement, ACK failure and uncertain Send do not.
- Send-attempt/acceptance diagnostics, a completed browser reply or streamed content veto a conflicting not_sent claim. Multiple physical operations also prevent another account attempt. An ACK already received on A therefore cannot authorize replay of its context on B.
- The next account uses the same processing model/effort. Initial context is rebuilt from authoritative native contents under B's account/epoch; no private A URL or A cache revision is reused. The separately requested context-staging model remains temporary and must be restored before COMMIT.
- Account and task leases transfer synchronously after A's operation settles. A cancelled HTTP response does not release a browser operation that is still preparing or generating. Retired attempt callbacks cannot reserve another physical request, emit results or change the current checkpoint.
- Routing settings are compared again at handoff. Sticky binding updates occur only after B's logical reservation is durable. Model-unavailable observations are scoped to the actual message's model, so unavailable context 3.8 is not recorded as unavailable processing model.

## Durable attempt history

Default/manual requests retain the legacy v1 ledger contract. Explicit failover requests use v2 metadata containing the immutable previous attempts, original account/epoch/physical receipt IDs, no-Send proof, owner UUID, absolute deadline and finite budget. No prompt, result or credentials are persisted in this ledger.

Each attempt is reserved and fsynced before browser work. Updates use a private per-record exclusive writer lock plus atomic replacement. Late callbacks cannot modify an older attempt. A new process can inspect v2 but cannot resume its prior owner's attempt chain; retry/restart cannot reset its budget. A terminal proven-unsent v2 request retains its fence, including after all attempts fail. It is not silently deleted for retry.

Reconciliation queries each attempt's original account/epoch, verifies physical receipt ownership and returns `replayAllowed:false`. It does not infer owners from the currently selected account or execute another Send.

Older source that lacks v2 support fails closed on those records. Legacy v1 records are not bulk rewritten. Crash locks are retained; there is no automatic lock deletion or rollback migration. Operator recovery/rollback acceptance remains P8 work. Process-kill tests do not prove recovery from power loss or disk failure.

## Validation

- Workspace build: PASS, `.tmp/p4-failover-r31-build.log`.
- Workspace typecheck: PASS, `.tmp/p4-failover-r31-typecheck.log`.
- Native: **125/125 PASS**, `.tmp/p4-failover-r31-native-full.log`. Includes legacy 2,100-record coverage, finite budgets, A preparation failure, explicit resume, policy drift, fixed model, stale callbacks, cancellation before preparation settles, conflicting Send evidence, CAPTCHA exclusion, and four real child-process kill barriers.
- Contracts: **9/9 PASS**, `.tmp/p4-failover-r31-contracts.log`, including strict invalid budget/manual-policy rejection.
- [Integrated HTTP/MCP/SQLite result](mcp/native-p4-failover-fixture.json): PASS, source revision 31. The real MCP service and SQLite store observe A Send=0, B Send=1, correlated owners for both attempts, retained budgets after restart and no duplicate Send after retry or global account selection changes. Browser/model behavior is synthetic; real Google requests=0. Probe: `node tools/probes/native-failover-smoke.mjs`.
- Browser and MCP source did not change in this milestone. Their prior 47/48 tests are not counted as fresh runs; the real MCP service is exercised by the integration probe above. No desktop, remote CI or live IDE executor acceptance is claimed.

## Controls and remaining gates

Example only, after enabling `AG_NATIVE_ROUTER_EXPERIMENTAL=1` on an idle owner:

```powershell
npm run native -- routing:set priority --model 'Exact Web model' --effort 'Exact effort' --failover --max-attempts 2 --failover-deadline-ms 60000
npm run native -- routing
npm run native -- routing:set manual
```

The current main owner has not been reconfigured or reloaded. Two signed-in profiles, real model availability, Web A ↔ B, the 3.8 staging → primary native loop, IDE execution and soak/recovery/rollback remain unaccepted. The existing P1/P2, P3 and P5–P8 gates still apply.
