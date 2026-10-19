# Native 36: validation before commit

Date: 19/10/2026. Native source **36**, browser worker fingerprint **23**. Parent commit: `ded32b2`. This checkpoint records the implemented upgrade work; the wider P0–P8 plan remains in progress.

## Included behavior

- Bounded turn/schema caches, compact tool schemas, composer readiness and validated read-only batching.
- Isolated account registry/workers, account/epoch-bound conversations, lossless context updates and guarded manual handoff.
- SQLite physical receipts and durable logical replay fences, finite opt-in failover, cancellation/progress and retained-file cleanup.
- Initial-context staging with 3.8 Flash and restoration of the captured primary model/Thinking level before COMMIT.
- Native owner-backed account and project-source controls in CLI/Electron, explicit selected local files/GitHub checkout provenance and stale-source checks.
- Pool ownership cleanup, deferred BUSY handling, bounded metadata and terminal shutdown. The semi-space measurements remain experiments; no Node memory default was changed.

## Fresh validation

`npm run build`, `npm run typecheck`, `npm run lint` and `npm test` all completed successfully against this source tree.

| Workspace | Passed | Failed / skipped / cancelled |
|---|---:|---:|
| contracts | 10 | 0 |
| gemini-browser | 47 | 0 |
| mcp-server | 49 | 0 |
| model-bridge | 4 | 0 |
| native-antigravity | 167 | 0 |
| runtime | 80 | 0 |
| launcher | 49 | 0 |
| Total | **406** | **0** |

Logs are retained locally under `.tmp/native-precommit-{build,typecheck,lint,tests}.log` and are not committed. Browser tests use owned local fixtures; these checks do not send Google prompts or operate the user's verification window.

The production CLI → child Native → actual MCP/SQLite fixture also passed: 13 CLI calls, 6 synthetic Sends, zero duplicates, stale-cache withdrawal, explicit per-account source binding and metadata removal preserving original files. [CLI artifact](mcp/native-r36-precommit-knowledge-cli.json).

The actual Electron/sandboxed-preload/HTTP source-management regression passed at widths 800/1280, in Vietnamese/light and English/dark, with no renderer errors. Browser and chooser grants were synthetic. [Desktop artifact and screenshots](native-r36-precommit-desktop/native-knowledge-desktop.json).

JSON parsing and relative Markdown file links were checked for the changed files. Credential-pattern and nonfixture-email scans found no matches in the text candidates. Only project source, tests, probes, documentation and evidence are included; generated builds, private runtime state, logs, browser profiles and environment files are excluded.

## Open acceptance and next work

The 3.8 → primary-model Native Web turn, two real accounts switching A ↔ B, and the complete IDE executor workflow still require live acceptance. The user's pending Google verification was not automated or disturbed. Context upload remains experimental; the 10-round long-context stability gate is open.

P6 Web adapters (Gem/Notebook/Drive/GitHub import), actual Windows chooser selection and live freshness/permissions gates remain open. External registrations currently record unverified metadata. P7's four independent branches remain planned. P8 still needs actual MCP/Chrome memory/process measurements, sustained load, crash/orphan recovery, baseline restore/rollback and Windows restart.

Next: continue P8 measurements with actual MCP shared-owner processes before choosing any memory policy. [Synthetic Node benchmark](g4-native-p8b-node-memory-benchmark.md), [full upgrade plan](../NATIVE_UPGRADE_PLAN.md), [recovery runbook](../NATIVE_RECOVERY_RUNBOOK.md).

This checkpoint does not establish remote CI, production readiness or completion of the full upgrade plan. No push, merge or deployment was performed.
