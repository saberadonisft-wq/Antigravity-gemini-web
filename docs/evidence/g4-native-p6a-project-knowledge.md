# P6a — Selected project references, source 34

Date: 18/10/2026. Source Native revision **34**, browser worker **23**. Status: **PASS local/CLI fixtures; P6 remains IN PROGRESS**. Default: `AG_NATIVE_KNOWLEDGE_EXPERIMENTAL` off. No real project source was sent to Google during this work.

## Implemented

- Owner-authenticated knowledge API, strict contracts, instance/revision CAS, atomic private metadata registry and retained crash locks. Status works while busy; source/binding mutations require idle.
- Explicit local-file selection and local GitHub-checkout provenance. SHA-256/commit snapshots, explicitly selected dirty/untracked overlays, CRLF/BOM/UTF-8 preservation, bounded selection and payload. Git reads do not invoke repo filters/textconv/fsmonitor or network fetches; partial clones are rejected.
- Task/account/identity-epoch bindings, source validation before each physical submission and final reply. Pre-Send source failure remains not_sent; a change after an accepted Send remains uncertain and fenced.
- References enter the existing versioned context while native request identity stays unchanged. A cached response whose used source changed is withdrawn without another Send. Optional invalid/stale/large sources are omitted with diagnostics while preserving the original IDE context.
- Finite failover re-resolves sources for B; A's binding is never carried over implicitly. Current native tool policy, nonce, validation and approvals remain authoritative.
- Production CLI import/check/refresh/bind/clear, metadata registration and removal. Removal refuses a source still bound anywhere and does not delete files or remote data.
- External Gem/Notebook/Drive/GitHub Web registrations remain metadata-only and independently not_verified. Gem registration requires a stable instruction version. No Web adapter is represented as live-ready.

## Fresh validation

| Check | Result | Evidence |
|---|---|---|
| Workspace build | PASS | `.tmp/p6-r34-build.log` |
| Workspace typecheck | PASS | `.tmp/p6-r34-typecheck.log` |
| Native suite | **154 pass, 0 fail**; includes 21 new knowledge cases | `.tmp/p6-r34-native-full.log` |
| Contracts suite | **10 pass, 0 fail** | `.tmp/p6-r34-contracts-full.log` |
| Launcher regression | **41 pass, 0 fail** | `.tmp/p6-r34-launcher-full.log` |
| Production CLI + Native/MCP/SQLite | **PASS**, 13 CLI calls, 6 synthetic browser Sends, 0 duplicates | [fixture artifact](mcp/native-r34-knowledge-cli-fixture.json) |
| Source inventory and validation boundary | Captured separately from main runtime | [source manifest](mcp/native-r34-knowledge-offline.json) |

The integration probe launches a real child Native owner, real in-process MCP service and SQLite WAL ledger; only browser operations are synthetic. Production CLI runs in an isolated test home with fetch restricted to the child loopback endpoint. Tests import only a temporary synthetic project and remove their own checked temp root after child shutdown. The existing P5 fixture enables knowledge only with an explicit test flag; its ordinary lifecycle mode remains off.

Covered failures include traversal/Windows aliases, credential exclusions, invalid UTF-8/NUL, selected file size, hardlink/junction, file rename/removal/content change, Git HEAD change, partial clone, explicit dirty/untracked overlay, empty Git blob, registry corruption/CAS/crash lock, epoch mismatch, busy mutation, unknown owner, reference-driven forbidden tools, native context cap, source mutation before/after Send, stale cached result, A→B manual selection and finite pre-Send failover. A configured executable filter/fsmonitor trap did not run.

## Boundaries and remaining work

There were **0 Google prompt requests** and **no real IDE executor** in these probes. Existing MCP/browser suites were not rerun merely to add their old counts to this milestone; the actual MCP service/SQLite path was exercised by the new CLI integration fixture. Prior P5 real-TTL and Electron artifacts remain historical evidence, not repeated P6 samples.

Main owner health was read without browser control: revision 29/manual, active=0, initial context model 3.8 Flash. It was not restarted or upgraded while the user finishes Google verification. Therefore this milestone does not validate the real 3.8 bootstrap → primary-model COMMIT flow.

Local freshness is not model answer quality or proof that a native file was read immediately before an edit. Native tool validation is enforced; the `view_file` freshness instruction still needs real IDE/model acceptance. Registry stores metadata, including private root paths, but not source bytes. P3 snapshot upload, if separately enabled, has its existing temporary-file lease lifecycle; this milestone does not prove P3 cleanup after every crash.

P6 still needs launcher source-selection UI, actual Web GitHub import, per-provider Gem/Notebook/Drive capability and permissions, real A/B source access, model-quality tests on a changing repo and IDE fresh-read-before-edit acceptance. P3 stability, P5 real accounts/IDE, P7 and P8 gates remain open. No commit, push, release, production restart or deployment was performed.

Usage and config rollback: [NATIVE_KNOWLEDGE.md](../NATIVE_KNOWLEDGE.md). Design: [ADR 0011](../adr/0011-native-project-knowledge.md). Official provider behavior and its limits are linked in the usage document; metadata registration is not permission or sync evidence.
