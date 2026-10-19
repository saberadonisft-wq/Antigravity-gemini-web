# P4 — Physical receipt store and reconciliation

Date: 2026-10-16. Source: native revision 26 / browser worker fingerprint 18. P4 is IN PROGRESS. Manual account selection remains the only routing mode; this milestone does not enable failover or concurrent routing across accounts.

## Storage decision

[Windows store spike](mcp/native-p4-ledger-store-spike.json) compared SQLite WAL with one indexed append-only file per request, each using durable writes for reserved/accepted/terminal phases. For 512 synthetic requests on this machine:

| Store | Three-phase writes | Lookup of all 512 |
|---|---:|---:|
| SQLite WAL, synchronous FULL | 179 ms | 1 ms |
| Hash-named append-only files, fsync per phase | 400 ms | 363 ms |

This is one local filesystem measurement, not a Gemini latency benchmark. SQLite was selected for indexed lookup, transaction boundaries, cross-process constraints and bounded JavaScript state. Process termination before COMMIT discarded the uncommitted row; termination after COMMIT preserved it. Both reopened with quick_check=ok. Power-loss and storage-hardware failure were not tested.

The implementation uses Node's built-in SQLite, with no new external database dependency. The supported Node range is 22.13+ within 22.x or 24+. The [Node 22.13 documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html) documents the DatabaseSync API and removal of the experimental command-line flag. The local evidence used Node 24.18.0 / SQLite 3.53.1; it does not substitute for a Node 22 CI run.

## Migration and reservation invariants

- `receipts.json.sqlite` stores only IDs, content hashes, phase, attempt UUID, timestamps and optional native correlation metadata. Prompts, model text, tool arguments and credentials are not stored.
- A primary-key reservation commits before browser mutation. Duplicate IDs cannot create another reservation; changed content conflicts. Delayed phase callbacks require the same attempt/hash/previous phase, and terminal phases cannot regress.
- SQLite is configured for WAL and synchronous FULL. There is no 2,048-row capacity check and no JavaScript array containing the complete receipt history. The existing result cache remains bounded at 32; expired answers remain unavailable and fenced.
- A strict legacy array of up to 2,048 receipts is imported transactionally without assigning a guessed account/owner. Exact original bytes are preserved in `receipts.json.v1.backup`.
- The old JSON path becomes a version 2 marker bound to the database store UUID. The old array reader rejects this marker. A missing database, foreign marker, corrupt source/backup or attempted rollback to an old array fails closed.
- Interrupted migration can resume at the tested barriers immediately before/after marker publication. On reopen, legacy backup digest and every imported ID/hash/phase are checked against the database; phases may advance but cannot regress.
- The backup is evidence of the original source, not a safe downgrade export after new receipts exist. No automatic downgrade or deletion of fences was added.

The [real metadata copy probe](mcp/native-p4-ledger-migration-copy.json) migrated a private copy of the current 135-entry legacy ledger, checked all IDs/hashes/phases and exact backup bytes, inserted one synthetic receipt, and reopened it successfully. The production source remained byte-for-byte unchanged. Browser requests: 0. Production writes: 0.

## Native correlation and read-only inspection

Before each physical fragment/commit is submitted, the native logical ledger saves its physical request ID. MCP persists the logical request ID, logical attempt UUID, account ID and identity epoch on that physical receipt. The mapping is bounded by the existing 11-message transport budget. Stale callbacks cannot attach receipts to a replacement/terminal logical turn.

`gemini_receipt` reads durable metadata without opening Chrome. Native owner control `POST /__native/reconcile` and CLI `npm run native -- receipt <logical_request_id>` query the original account/epoch, regardless of the currently selected account. These controls require the owner's token. Inspection does not clear a fence, reconstruct a missing answer or submit a prompt.

A `terminal` physical phase means the broker finished handling that request. It is not proof of a successful model answer or an IDE tool execution. After restart, metadata can remain available while the answer is unavailable. Missing receipts, legacy receipts without correlation and mismatched attempts do not authorize replay.

[HTTP + SQLite reconciliation probe](mcp/native-p4-receipt-reconciliation.json) used real loopback native HTTP, the actual MCP service/store and synthetic browser/executor behavior. It verified:

- A generated once; the services/proxy restarted and B became selected.
- Reconciliation queried only A's store and verified the original physical owner. The answer was not restored from metadata.
- An unauthenticated inspection was rejected. A mismatched attempt or changed identity epoch was rejected.
- A missing physical receipt remained non-replayable. Retrying the original request with B selected returned OUTCOME_UNKNOWN.
- Send counts stayed A=1, B=0. These are fixture counts, not a two-account Gemini Web acceptance claim.

## Validation

- Workspace build PASS: `.tmp/p4-ledger-build-verified.log`; final targeted store 7/7 PASS: `.tmp/p4-ledger-store-tests-verified.log`; final HTTP reconciliation PASS: `.tmp/p4-ledger-reconciliation-verified.log`. Full MCP build/test logs remain below.
- Contracts 8/8 PASS: `.tmp/p4-ledger-contracts-tests.log`.
- Native 90/90 PASS: `.tmp/p4-ledger-native-tests-final.log`.
- MCP 44/44 PASS: `.tmp/p4-ledger-mcp-tests-final2.log`. This includes a full 2,048-entry migration, 2,100 completed physical browser fixture requests, restart fences, five process-crash barriers, three synchronized competing processes, stale callbacks and real stdio discovery of the seven browser tools without Chrome.
- The first MCP run after adding the tool failed because a stdio discovery assertion still expected six tools (`.tmp/p4-ledger-mcp-tests-final.log`). The assertion and actual metadata lookup were updated for the seven-tool contract; the final full MCP run passed.
- Workspace typecheck PASS: `.tmp/p4-ledger-typecheck.log`. Whitespace/probe syntax checks are recorded separately in `.tmp/p4-ledger-diff-check.log`.
- Browser implementation was unchanged in this milestone; its prior 43-test P3 run is not presented as a new P4 browser run. Desktop, remote CI, real two-account routing and IDE executor acceptance were not run here.

## Runtime and remaining gates

At 2026-10-16T15:51:35Z, the main owner was still revision 25, PID 11912, idle, Default Account selected and experimental upload disabled. This milestone built and tested revision 26 / worker 18 in isolated fixtures; it did not migrate the production ledger or reload the main owner. A compound restart command was rejected by automatic approval review in the prior milestone; no new restart was attempted here.

### Follow-up: live runtime and migration, 2026-10-17

The prior exec handle was no longer present. Independent inspection confirmed that owner PID 11912 did not exist and port 9236 actively refused connections. The already-built runtime was started with the ordinary `npm run native:start` command; no competing owner was stopped or replaced.

At 2026-10-17T04:02:28Z, revision 26 / PID 1680 verified Default Account (epoch 1), `promptSent: false`. The worker upgraded the actual 135-entry legacy ledger. A separate [read-only SQLite inspection](mcp/native-r26-ledger-live-inspection.json) confirmed store UUID/marker consistency, WAL, quick_check=ok and preservation of every legacy ID/hash/phase without guessing owners. Exact backup SHA-256 matches the previously validated copy. Total receipts remained 135; the inspection sent no browser requests. The native health counters remained at zero generated requests and experimental upload stayed off.

This supersedes the earlier runtime-not-loaded boundary only. It does not satisfy the real two-account, IDE executor, P3 attachment, router/failover or soak gates.

Follow-up: source 27 added [experimental routing](g4-native-p4-routing.md); source 31 now adds [finite no-Send failover and durable logical attempt chains](g4-native-p4-failover.md). Actual HTTP, MCP and SQLite fixture integration passes, including restart fences and per-attempt receipt ownership. Runtime remains 29/manual while the user completes Google verification. Real two-account failover, IDE execution and soak/recovery/rollback acceptance are still open.

P1/P2 still need two real signed-in accounts and IDE executor acceptance. P3 later obtained passing 145k/261k retained-file samples, while smaller samples still failed; the stability gate remains open and upload remains off by default. See [P3 evidence](g4-native-p3-context-transport-spike.md). P5–P8 remain open, including launcher controls, knowledge adapters, supplementary workflows, soak and migration/rollback release acceptance.
