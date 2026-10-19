# P5 — Process restart, CLI and real cache expiry

Date: 2026-10-18. Source: Native **33 / browser worker 23**. P5 remains IN PROGRESS: real Google accounts and the IDE executor are still unaccepted. The user's main owner remains revision 29/manual while its browser verification window is preserved.

## Cache bug and fix

MCP pruned its 32-result/10-minute cache during submit and settlement, but `result`, `inspectReceipt` and `status` did not prune it. A client that only read results could still retrieve a response after its TTL; receipt inspection advertised that expired response as available.

The [before probe](mcp/native-r32-cache-expiry-before.json) reproduces that behavior using an isolated process clock offset: after 600,001 ms, `resultAvailable=true` and `resultStatus=completed`. This is a deterministic reproduction, not elapsed-time acceptance.

Source 33 checks expiry on those MCP read APIs. Native health and management snapshot reads also retire expired Native RAM results. Existing durable receipt IDs, ownership, previous attempts and no-replay fences are preserved. The [after probe](mcp/native-r33-cache-expiry-after.json) reports `resultAvailable=false`, `OUTCOME_UNKNOWN`, one synthetic Send and the retained receipt.

## Actual process, CLI and Electron fixture

[Full lifecycle evidence](p5-native-lifecycle/native-lifecycle.json) PASS uses:

- A Native owner in a real child process, terminated with SIGKILL and recreated on the same owned loopback port with a new PID and owner instance.
- Actual Native CLI source in separate Node processes. A test preloader isolates its home and redirects its fixed loopback origin into the owned fixture; external fetches are rejected. This validates CLI logic and ownership against real HTTP, rather than the production port/profile or real IDE sign-in.
- Real Electron with sandboxed preload and IPC, the production Native owner client, an actual MCP service through an in-process broker adapter, and real SQLite WAL persistence. Browser/model behavior is synthetic; no Google prompt is sent.

The fixture verifies account add/use/verify, stale account revisions, stale owner instances, UI locking while the owner is gone, and CLI refusal to start a missing owner implicitly. After crash/restart, the same logical request returns `OUTCOME_UNKNOWN` with no second Send. CLI receipt inspection still queries the original account after selection changes; physical owner correlation remains verified and the old RAM result is unavailable.

Login expiry and model-unavailable scenarios fail before synthetic Send. The model policy remains fixed. Identity verification expires visibly after 30 seconds instead of keeping a permanent checked badge.

The full test waits **601,435 ms monotonic / 601,450 ms wall time** after a terminal result, using the real default 600,000 ms TTL. It then verifies Native retry returns `OUTCOME_UNKNOWN`, the physical receipt remains correlated, `resultAvailable=false`, `replayAllowed=false`, and the total synthetic Send count stays **2** across the baseline and TTL requests. The clock is not advanced in this full test. This is not a Windows reboot, power-loss test, Google session test or IDE executor test.

The [quick fixture](p5-native-lifecycle-quick/native-lifecycle.json) repeats the other controls after a UI feedback fix. It explicitly records TTL as NOT_RUN and is not counted as a second elapsed-time sample. Old success feedback is now removed when the owner disconnects or a newer context replaces it; cancellation confirmation is retained only for the same owner/revision/turn. [Disconnected UI](p5-native-lifecycle-quick/lifecycle-owner-disconnected.png), [login error](p5-native-lifecycle-quick/lifecycle-login-required.png), [model error](p5-native-lifecycle-quick/lifecycle-model-unavailable.png).

## Validation

- Workspace build and final launcher build PASS: `.tmp/p5-lifecycle-r33-build.log`, `.tmp/p5-lifecycle-r33-launcher-final-build.log`.
- Workspace typecheck PASS: `.tmp/p5-lifecycle-r33-typecheck.log`; final launcher build also typechecks the later native-account feedback change.
- Native **133/133**, MCP **49/49**, contracts **10/10**, launcher **41/41** PASS: **233** across these packages. Logs: `.tmp/p5-lifecycle-r33-native-full.log`, `.tmp/p5-lifecycle-r33-mcp-full.log`, `.tmp/p5-lifecycle-r33-contracts-full.log`, `.tmp/p5-lifecycle-r33-launcher-verified.log`. Browser/runtime packages were unchanged and their old counts are not added.
- [Validation manifest](mcp/native-r33-lifecycle-offline.json) records the counts, actual TTL durations, current source hashes and unchanged live owner observation.
- [Account controls at revision 33](p5-native-accounts-r33/native-accounts-desktop.json) PASS: actual Electron/IPC/HTTP with synthetic browser, cancel, resume, verification-shaped error, 1280/800px layout, keyboard and contrast. Historical revision-32 screenshots/evidence remain intact.
- Full real-TTL log: `.tmp/p5-lifecycle-r33-real-ttl.log`. Quick post-feedback-fix log: `.tmp/p5-lifecycle-r33-quick-verified.log`.

Reproduce after build:

```powershell
npm run test:desktop-native-lifecycle
# Diagnostic run without waiting for TTL; its output states TTL NOT_RUN:
npm run test:desktop-native-lifecycle -- --quick
```

The full run needs roughly 11 minutes. It uses temporary isolated state and owned synthetic browser adapters. The test's initial file-based controller hit a Windows EPERM while replacing a file under a reader; the controller now uses unique request/reply files. That correction changes the fixture controller, not the production ledger writer policy.

## Remaining work

[Recovery runbook](../NATIVE_RECOVERY_RUNBOOK.md) now covers account/binding recovery, ambiguous Stop, expired/full/corrupt ledgers, upload leases, model restoration and configuration rollback. A document is not proof that every recovery/rollback path works from a production baseline.

Real A ↔ B, the 3.8 staging → primary model loop, native IDE read/edit/checker execution, live Stop, full P3 stability and P8 soak/migration/binary rollback remain open. P6 and P7 scope is unchanged. No live owner reload, commit, push, CI, merge or deployment was performed in this milestone.
