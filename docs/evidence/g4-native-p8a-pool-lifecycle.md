# P8a — Pool ownership cleanup and shutdown, source 36

Date: 18/10/2026. Source Native **36**, browser worker **23**. Status: **PASS pool/HTTP/CLI fixtures; P8 remains IN PROGRESS**. Main runtime remains unreloaded while Google verification is pending.

## Reproduced defect

The bound backend returned by `bindAccount` called the raw backend's `releaseConversation` directly. It skipped ownership removal and the pool's deferred BUSY queue. The failed-turn Native path uses this bound method, so BUSY cleanup could be lost and ownership metadata retained.

The pre-patch standalone pool probe performed 500 warmup rounds and 10,000 additional generate/release rounds with synthetic backends. It retained **10,501 ownership entries**, and BUSY cleanup produced no queued retry. This is component evidence, not 10,000 real Native/Google conversations. [Before artifact](mcp/native-r35-pool-cleanup-before.json).

## Change

- Bound cleanup uses pool release/queue logic, checks its captured backend, rejects another account's known key and removes ownership on success. Pending preserve=true dominates a weaker retry; another account never drains this owner's queue.
- Hard bounds: **32 cached backend handles**, **256 ownership entries**, **256 deferred releases per account**. A new ownership entry at capacity fails before generation with a not_sent/checkpoint proof. Cleanup errors after Send retain uncertainty and never acquire that proof.
- Health exposes path-free `backendResources` counts/lifecycle/limits. These are in-process handles/metadata, not OS process counts or a RAM budget. Idle-worker eviction is not implemented here.
- Shutdown is terminal/idempotent and waits for every close to settle. Close failures stay failures on subsequent calls. Late generation, identity enrollment and BUSY cleanup cannot return success, change enrollment, repopulate a closed queue or create another worker through the closed pool.
- RESOURCE_LIMIT has an explicit Native/launcher message. It is not an account sign-in/model failure or an allowed automatic failover reason. Request identity and durable ledger formats are unchanged.

## Validation

| Check | Result | Evidence |
|---|---|---|
| Workspace build/typecheck/lint | PASS | `.tmp/p8-r36-build.log`, `.tmp/p8-r36-typecheck.log`, `.tmp/p8-r36-lint.log` |
| Native suite | **167 pass, 0 fail**, including 12 new lifecycle cases | `.tmp/p8-r36-native-tests.log` |
| Launcher regression | **49 pass, 0 fail** | `.tmp/p8-r36-launcher-tests.log` |
| Contracts suite | **10 pass, 0 fail** | `.tmp/p8-r36-contracts-tests.log` |
| Pool metadata/GC probe | 500 warmup + 10,000 rounds, ownership/pending release return to zero | [After artifact](mcp/native-r36-pool-cleanup-after.json) |
| Native HTTP failure → cleanup → restart | Original A cleanup only; failed request never sent again, including after restart | `pool-lifecycle.test.ts` |
| CLI → Native → actual in-process MCP/SQLite | PASS, 13 CLI calls, 6 synthetic Sends, no duplicate | [CLI artifact](mcp/native-r36-knowledge-cli-fixture.json) |
| Source-management Electron workflow | PASS, actual Electron/preload/HTTP, synthetic browser/chooser grant | [Desktop regression](p8-native-knowledge-regression-r36/native-knowledge-desktop.json) |
| Source hashes/current boundary | Recorded separately from main owner | [Manifest](mcp/native-r36-pool-lifecycle-offline.json) |

Fresh relevant unit/regression count: **226**. Cases cover BUSY/owner isolation, ownership release, pending-preserve dominance, worker replacement, pre-Send capacity, post-Send cleanup failure, untrusted BUSY-like errors, close failure/idempotency, all-settled shutdown, late BUSY/identity/response and durable replay fencing after a real HTTP owner restart.

The GC probe runs a separate Node process with two synthetic backend objects. It records RSS, heapUsed/heapTotal and V8 heap-space samples after explicit GC/macrotask gaps. Its PASS applies to ownership/queue lifecycle, **not production RSS/worker/Chrome stability**. RSS grew in local sampling while live heap changed little; the memory-budget/plateau gate remains unproven. Before has one terminal GC sample; the final probe has intermediate instrumentation, so raw RSS is an observation rather than a controlled before/after memory benchmark.

Unchanged browser/MCP full-suite counts were not borrowed from earlier milestones; the actual MCP/SQLite path was checked by the CLI fixture. Previous evidence remains preserved.

## Real Windows chooser attempt

A test-only interactive mode opens the actual Windows file dialog without substituting chooser paths. Computer Use observed the dialog open and a Cancel result. Selection did not complete: a cached UI element became unavailable and a fresh observation did not show the target dialog. Input stopped; only the owned test child was terminated and its temp root removed. **No selection PASS is claimed.** [Partial attempt](p6b-native-real-chooser-r35/attempt.json).

A later owned retest can use `node apps/launcher/scripts/native-knowledge-smoke.mjs --real-chooser`; it is interactive, not an unattended green check. Browser remains synthetic there. The harness does not automate Google verification/authentication.

## Remaining gates

There were **0 real Google prompt requests** in these probes. Main owner was read-only revision 29/manual with 3.8 Flash staging; its browser was not restarted, navigated or upgraded. The real 3.8 → primary-model turn still awaits user verification.

P8 still needs actual multi-worker/browser RSS and process limits under sustained load, crash/orphan-file recovery, baseline restore/rollback, Windows restart and open core Web/IDE/account gates. Cached-handle limits are compatibility bounds, not optimized RAM targets. P6 live adapters/chooser selection, P7 and the wider plan remain open. No commit, push, public sharing, merge or deployment was performed.

Recovery: [runbook](../NATIVE_RECOVERY_RUNBOOK.md). Scope: [NATIVE_UPGRADE_PLAN.md](../archive/plans/NATIVE_UPGRADE_PLAN.md).
