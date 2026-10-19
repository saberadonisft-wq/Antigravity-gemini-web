# P8f: rollback with independent dependency lockfiles

Date: 19/10/2026. Tested production commits: baseline **`4e28d7a` / Native 36** and current **`2804560` / Native 38**, worker 24. Status: **PASS owned module/state rollback; broader P8 gates remain open**.

P7a added ZIP dependencies and P7b changed Native's API. The old 36/37 probe required identical lockfiles and hardcoded revision 37, so it could not establish recovery compatibility for source 38. It now requires two prepared isolated builds, imports the tested current modules from their own dependency tree and records each lockfile separately.

## Fresh validation

`native-recovery-build.mjs` created two detached worktrees, ran independent `npm ci --ignore-scripts --prefer-offline --no-audit --no-fund` and full workspace builds, and recorded successful exit codes plus source commit, Node version, lockfile/installed-lock and compiled module hashes. All seven workspace links must resolve inside their respective checkout. A preparation receipt is checked again before any recovery owner starts. It is local build provenance, not an external attestation or package-integrity certification.

| Build | Native | Lock SHA-256 | Install/build |
|---|---:|---|---|
| `4e28d7a` | 36 | `4b7b6af54fba1791f81db3945d13393fcf8f90a8bb52cbcf945d93c3b7f618c8` | PASS / PASS |
| `2804560` | 38 | `41c721a4a65619af5cbba325bbe3b70dbed90b78cd2f70a23ffe45f37a04f686` | PASS / PASS |

An [adversarial authority check](mcp/native-r38-recovery-build-authority.json) rejects swapped build roles, modified compiled ledger code, a modified installed lock, modified tracked source and an orphan directory that would otherwise make `git -C` fall back to the parent repository. Every byte changed for these checks was restored and both prepared builds were reverified. No Native owner is started by these checks.

The [actual recovery run](mcp/native-r38-baseline-recovery.json) then passes **36 → 38 → crash → cold restore → 36 → 38**. The child runs actual Native HTTP, MCP service and SQLite; browser delivery is synthetic. It verifies duplicate coalescing before restart, old-ID rejection across revisions, backup rejection while a writer is live, immutable backups, old/corrupt backup rejection without changing live bytes, a nonempty WAL after killing the accepted-response owner, restored receipt correlation and byte-identical v2 attempt/deadline history. Explicit Resume adds no Send; only a new follow-up is sent.

Final state: **five logical fences, four physical receipts, four synthetic Sends, zero duplicate Sends**. Every fixture writer exited and the successful state fixture's exact owned temp root was removed. The two prepared build worktrees are retained under ignored `.tmp` for reproduction; they are source/build caches with no running fixture owner. The previous blocked cleanup residue was not touched.

Syntax checks PASS for all three probe scripts. This increment changes probes and documentation only. The **436-test/build/typecheck/lint pass belongs to `2804560`**, as recorded in [P7b](g4-native-p7b-chat-import-preview.md); it is not recounted as a new workspace test run here. Fresh independent builds and both actual probe workflows are the new evidence. Logs: `.tmp/p8f-{prepare,authority,recovery}.log`, and each prepared build's `.tmp/{install,build}.log`.

## Reproduce

From a built checkout with the current production source committed:

```powershell
node tools/probes/native-recovery-build.mjs
node tools/probes/native-recovery-provenance-check.mjs
$builds = Get-Content .tmp/native-recovery-builds.json -Raw | ConvertFrom-Json
node tools/probes/native-baseline-recovery.mjs ("--baseline-dir=" + $builds.baseline) ("--current-dir=" + $builds.current) --output=.tmp/native-baseline-recovery.json
```

Preparation retains isolated builds and does not clean old worktrees or delete profiles. A failed preparation cannot produce a successful receipt. Recovery refuses unprepared/dirty/mismatched builds before creating its state fixture. Its normal state cleanup is limited to the generated fixture temp directory, after all child writers exit; failed state fixtures are retained.

## Limits

This tests the exact listed commits and dependency trees, not arbitrary future releases. It uses a current synthetic harness against pinned production modules, not the old CLI startup or actual stdio/shared-owner binaries. Real Chrome/profile restore, active browser uploads, a Windows restart, a crash between replacement of multiple state directories and damaged production-state repair remain unverified. The cold restore guard refuses to drop/rewind metadata; it is not a merge/repair implementation.

No main proxy/browser restart, account action, Google request, public share, push, merge or deployment was performed. P6/P7 live adapters, two real accounts, full IDE executor and soak/release gates remain in the [complete plan](../NATIVE_UPGRADE_PLAN.md).
