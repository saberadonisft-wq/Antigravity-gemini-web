# P8: cold metadata restore and baseline module rollback

Date: 19/10/2026. Current source Native **37 / worker 24**, baseline **36 / worker 23** from commit `4e28d7a`. Status: **PASS owned-state HTTP/module/store fixture; production recovery gate remains OPEN**.

## Baseline and actual components

An isolated detached worktree of `4e28d7a` was installed with `npm ci --ignore-scripts --prefer-offline --no-audit --no-fund` and built across the full workspace. Its dependency lock hash matches the current checkout. Its contracts workspace link was checked to point to its own package, and tracked baseline sources remained clean.

The probe forks a common synthetic test harness whose seven production imports are rewritten to absolute module URLs under the selected build. This permits the same crash and explicit-resume controls while keeping baseline production sources unchanged. Actual Native HTTP, backend generation/transport logic, MCP service and SQLite stores execute from that build; health confirms each runtime revision. The MCP service is in the same fixture child as Native, using a direct test broker adapter. This does not test production stdio/shared-owner bootstrap or Chrome/profile rollback.

## Verified sequence

1. Source 36 completes request A once; a same-process retry returns its cached result. Cold backup is refused while a writer is live. All writers then exit and the first backup is copied.
2. Source 37 opens that state, blocks replay of A and completes new request B. A v2 logical fence is seeded through the public ledger API with two account attempts, an immutable prior no-Send proof, a fixed deadline and terminal unknown state. This seed is metadata compatibility coverage, not a real model failover.
3. Restoring the older backup is refused because current metadata would be omitted or rewound. A corrupt snapshot also fails its checksum. Both refusals leave original metadata byte-identical.
4. Source 37 is killed at a fsynced synthetic response barrier, after the physical receipt is `accepted` and before a result is returned. The caller observes a lost connection; no retry occurs. The cold backup contains a nonempty WAL and the complete SQLite/marker/SHM group.
5. The newest backup is validated on a disposable clone, leaving immutable backup bytes untouched by SQLite recovery/read marks. Its metadata is restored to the original owned paths; displaced state is quarantined rather than overwritten. Source 36 opens the restored stores and blocks all old request IDs. Reconciliation finds the crash receipt still `accepted`, with verified logical/account correlation. The v2 attempt/deadline fence remains byte-identical.
6. A new follow-up in the unresolved chat is correctly blocked. An explicit Resume is armed for the original account and synthetic stopped URL without adding a Send; only the new follow-up D is sent. Failed request C is never replayed.
7. Source 37 opens the state again and blocks A/B/C/D and the seeded v2 request. Final state has **five logical fences, four physical receipts, four synthetic Sends and zero duplicates**.

All fixture writers exited, and the successful run's exact owned temp root was removed. No Google prompt, Chrome process, real IDE executor or production state was used. [Recovery artifact](mcp/native-r37-baseline-recovery.json).

The existing production CLI/Native/MCP/SQLite knowledge regression also passed after the test-only harness changes: 13 CLI calls, six synthetic Sends and no duplicate. Recovery flags are absent in normal fixture mode. [Regression artifact](mcp/native-r37-knowledge-cli-regression.json).

The **415-test workspace pass belongs to commit `a946b6c`**. This follow-up changes probes/harness/docs, not production TypeScript modules; it ran syntax checks and the two actual fixture workflows instead of recounting that suite as new work.

## Restore limits

This probe accepts only a generated owned temp root and a checked isolated baseline. It is not a production backup/repair CLI. Its conservative restore guard requires every existing metadata file to be present with identical bytes in the snapshot; it does not merge older stores or infer that an unknown fence may be discarded. Accounts retain their original absolute profile/state paths.

Directory replacement is deliberately offline and sequential, with displaced state retained. Crash atomicity across multiple directories, other writers outside the owned fixture, Windows restart, restoration of a damaged production store, older pre-SQLite binaries and real browser/profile/IDE recovery are not proven. A failed fixture is retained for diagnosis. The first run exposed the expected unresolved-chat guard; the final workflow verifies explicit Resume rather than weakening it.

## Reproduce

Prepare a fresh ignored worktree and require each install/build command to succeed:

```powershell
$baselinePath = Join-Path (Get-Location).Path ('.tmp/p8-baseline-r36-' + [guid]::NewGuid().ToString('N'))
git worktree add --detach "$baselinePath" 4e28d7a
Push-Location -LiteralPath $baselinePath
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
npm run build
Pop-Location
node tools/probes/native-baseline-recovery.mjs "--baseline-dir=$baselinePath" --output=.tmp/baseline-recovery.json
```

Do not point this fixture at real account state. The probe itself validates baseline commit, clean tracked sources, dependency links, hashes, runtime revisions, writer exits and path boundaries. Artifacts record the production module hashes for both builds.

The prepared baseline's worktree registration was removed after validation. Git's filesystem cleanup left a residual directory with an orphan workspace junction. Automatic approval review rejected the subsequent scoped PowerShell removal with `blocked by policy`, without a more specific reason. The residue remains ignored under `.tmp/p8-baseline-r36-a946b6c`; it is not a running or registered worktree. The earlier failed fixture's recorded writer PID was confirmed absent before its owned temp root was removed.

See the [recovery runbook](../NATIVE_RECOVERY_RUNBOOK.md) and [full upgrade plan](../NATIVE_UPGRADE_PLAN.md). No main proxy/browser restart, push, merge or deployment was performed.
