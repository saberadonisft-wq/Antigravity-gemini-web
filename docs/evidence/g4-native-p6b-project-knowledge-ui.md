# P6b — Project references in the launcher, source 35

Date: 18/10/2026. Source Native **35** / browser worker **23**. Status: **PASS offline UI/IPC/HTTP + CLI fixtures; P6 remains IN PROGRESS**. Source references remain off by default. Main runtime was not reloaded while the user completes Google verification.

## Result

The launcher now has **Nguồn dự án / Project references**. Users can name/import selected local files, review relative filenames/version/hash, check freshness, explicitly accept a new local snapshot, select up to eight sources for a chat/account/epoch, clear a binding and remove unused metadata without deleting files. Existing GitHub-checkout sources imported by CLI can be managed here; new dirty/untracked overlays still require explicit CLI selection. Web integrations remain metadata-only/not_verified and cannot be newly selected in the UI.

Import IPC accepts only a label and owner/revision, with no caller paths. Main checks current authority/idle/feature state, runs a single-flight OS chooser, derives a common root from its granted files and submits to the authenticated owner. Chooser cancel makes no source. All three knowledge IPC methods enforce main frame, registered sender, origin, arity, strict command/result schemas and bounded responses. Renderer cannot import a root or register an integration URL through execute. Token, absolute roots and source bytes do not cross IPC; selected relative paths are separately validated, including on reading persisted metadata.

The UI keeps account/task selection explicit and does not transfer sources on account change. Polls cannot overwrite a pending mutation, duplicate chooser clicks coalesce, stale/disabled/busy/offline authority blocks actions, changed epochs reject binding and mutations are never retried by polling. Owner/account state is read again after a completed mutation. Unchanged metadata polls preserve draft checkboxes; configuration changes reload them. The sidebar stays available while scrolling long source lists.

Account binding applies to additional bridge references. It does not strip source-derived content already present in the IDE's supplied native history; that original context remains lossless and can accompany an account switch. This boundary is disclosed beside the UI selection.

## Validation

| Check | Result | Evidence |
|---|---|---|
| Workspace build + final launcher build | PASS | `.tmp/p6b-r35-build.log`, `.tmp/p6b-r35-launcher-build.log` |
| Workspace typecheck | PASS | `.tmp/p6b-r35-typecheck.log` |
| Native suite | **155 pass, 0 fail** | `.tmp/p6b-r35-native-tests.log` |
| Contracts suite | **10 pass, 0 fail** | `.tmp/p6b-r35-contracts-tests.log` |
| Launcher suite | **49 pass, 0 fail**, 8 new UI/store/main/IPC cases | `.tmp/p6b-r35-launcher-tests.log` |
| New Electron workflow | PASS, real Electron/preload/HTTP | [desktop artifact](p6b-native-knowledge-r35/native-knowledge-desktop.json) |
| Existing desktop suite | PASS after IPC/navigation changes | [security/UI](p6b-desktop-regression-r35/desktop-smoke.json), [UI regression](p6b-desktop-regression-r35/desktop-ui.json), [lifecycle](p6b-desktop-regression-r35/desktop-lifecycle.json) |
| CLI + Native/MCP/SQLite | PASS, 13 CLI calls, 6 synthetic Sends, 0 duplicates | [source 35 CLI fixture](mcp/native-r35-knowledge-cli-fixture.json) |
| Current source inventory/boundary | Captured with hashes | [source manifest](mcp/native-r35-knowledge-ui-offline.json) |

Total fresh unit/regression tests: **214**, plus the separate integration probes. Unchanged browser/MCP test suites were not rerun to inflate that count; the actual MCP service and SQLite path were exercised in the CLI fixture. Source 34 artifacts remain historical evidence and were preserved.

The new desktop workflow verifies imported selection, relative-path redaction, separate A/B bindings, stale check/refresh, external sources staying unverified, cancellation without import, credential-file exclusion, controls locked during an actual held Native turn, descriptor-unavailable recovery, source removal preserving files, Vietnamese and English under the light theme, 800px/1280px layouts, keyboard focus and minimum 44px control targets. It reported zero renderer errors and no horizontal overflow. Computed light-theme contrast for rendered enabled controls/body text was checked against 4.5:1. Screenshots were captured with warmed frames and visually inspected.

| State | Screenshot |
|---|---|
| Vietnamese/light | [Overview](p6b-native-knowledge-r35/knowledge-light.png), [source list](p6b-native-knowledge-r35/knowledge-sources-light.png) |
| English/light | [Overview](p6b-native-knowledge-r35/knowledge-english-light.png), [source list](p6b-native-knowledge-r35/knowledge-sources-english-light.png) |
| 800px width | [Narrow layout](p6b-native-knowledge-r35/knowledge-800px.png) |

## Acceptance boundary

The browser and chooser **grants** in the new desktop probe are synthetic. The probe exercises the real main import handler after a test-owned chooser grant; it does not interact with a real Windows file-dialog window. The two generation calls are synthetic (seed chat plus held/busy turn), not Google traffic. Actual OS chooser interaction remains a manual acceptance item. The CLI probe uses a real child Native owner, actual in-process MCP and SQLite with a synthetic browser, not an IDE executor.

There were **0 real Google prompt requests**. Main owner was observed read-only as revision 29/manual/idle with 3.8 Flash for initial context; it was not restarted, navigated or upgraded. The real 3.8 staging → primary COMMIT flow still awaits the user's Google verification.

Later real-chooser attempt: the Windows dialog opened and returned Cancel, but selection was not completed after Computer Use lost target state. Input stopped and the owned sandbox was closed; [partial evidence](p6b-native-real-chooser-r35/attempt.json) remains NOT_COMPLETED. Source 36 also fixes pool cleanup/shutdown; [P8a evidence](g4-native-p8a-pool-lifecycle.md) does not change the original source 35 fixture boundary above.

This does not close Web GitHub import, Gem/Notebook/Drive capabilities or per-account permissions, source quality on changing repositories, IDE fresh-read-before-edit, two real accounts, P3 stability, P7 or P8. Metadata/current-local-byte checks do not prove a model used a source correctly. No commit, push, deployment, public share or credential/profile migration was performed.

Usage/rollback: [NATIVE_KNOWLEDGE.md](../archive/guides/NATIVE_KNOWLEDGE.md), [recovery runbook](../NATIVE_RECOVERY_RUNBOOK.md), [ADR 0011](../archive/adr/0011-native-project-knowledge.md). Full scope remains in [NATIVE_UPGRADE_PLAN.md](../archive/plans/NATIVE_UPGRADE_PLAN.md).
