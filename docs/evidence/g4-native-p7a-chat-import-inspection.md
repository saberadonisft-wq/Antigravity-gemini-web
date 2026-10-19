# P7a: local chat archive inspection

Date: 19/10/2026. Baseline `51d2542`. Native proxy revision **37** and browser fingerprint **24** are unchanged: this increment adds an offline CLI path and a reusable inspector, not a browser import API. Status: **PASS local inspection; P7 import workflow IN PROGRESS**.

## Implemented behavior

`native:imports:inspect -- --provider chatgpt|claude --file <selected.zip>` hashes a selected file in 64 KiB blocks and reads ZIP/ZIP64 directory metadata lazily. A custom random-access reader shares the inspector's held file handle, so the ZIP reader cannot close it before the final identity checks. No entry payload is decompressed, parsed as chat/native context or executed.

The result exposes only leaf filename, declared provider, byte count, SHA-256, timestamp and aggregate directory counters. Compressed/uncompressed totals are decimal strings. It always states directory_metadata_only, contentsCrcVerified=false, not_submitted and requires_live_validation. It does not infer provider, conversation count, account eligibility, Google compatibility or migration success.

The inspector checks file type/identity, hardlinks and path components, bounds archive bytes and entry count, accepts cancellation and checks metadata again after reading. Progress reports hash bytes only. There is no persistent import state or transfer fence yet because no upload is performed. The selected archive is left unchanged; a future uploader must revalidate it and bind the target account/identity epoch.

Runtime reader `yauzl` is pinned at **3.4.0**, with matching type declarations. Test writer `yazl` and its types are dev-only **3.3.1**. New lockfile entries are checked in. The runtime dependency audit on this date reports zero vulnerabilities; this is a registry snapshot, not a security certification.

## Validation

Build, typecheck and lint PASS. Full workspace: **423 tests PASS**, zero fail/skip/cancelled:

| Package | Passed |
|---|---:|
| contracts | 13 |
| gemini-browser | 47 |
| mcp-server | 52 |
| model-bridge | 4 |
| native-antigravity | 178 |
| runtime | 80 |
| launcher | 49 |

Eight new tests cover restricted public projections, ZIP/forced-ZIP64 reads, original-byte hashes, untrusted tool-like payloads remaining data, malformed/truncated files, unsupported providers, cancellation and reuse, mid-read changes, hardlinks, oversized ZIP64 entry declarations, traversal names and strict CLI argument handling. The actual production CLI runs under a guard that forbids fetch and redirects home lookup to an absent owned fixture home; it returns the inspection without creating account state. Small forced-ZIP64 fixtures prove format handling, not a tested 5 GB upload.

Logs: `.tmp/p7a-{build,typecheck,lint,all-tests,focused-tests}.log`, `.tmp/p7a-runtime-audit.json`. [Source/test manifest](mcp/native-r37-chat-import-local-offline.json). Reproduce focused coverage after build:

```powershell
node --test --test-timeout=15000 packages/contracts/dist/chat-import.test.js packages/native-antigravity/dist/chat-import.test.js
```

## Remaining scope

This is the first implementation step of P7's import branch. OS chooser/preview, account/epoch-bound browser capability probing, upload with a receipt/fence, partial/unknown handling, actual imported-history/attachment fidelity and memory-text import remain unimplemented or unverified. Gemini A → B is not claimed. P7's other three branches and all open core/P6/P8 live gates remain in the plan.

The previous P8 baseline recovery artifact belongs to `51d2542` and its then-matching lockfiles. Dependencies changed here; the checkpoint's exact-lock recovery probe must not be treated as freshly rerun for this tree. Before release, repeat rollback acceptance against independently installed baseline/current lockfiles and the final runtime. No current recovery/production gate is closed by the new inspection tests.

No real Google prompts, browser/profile actions, main runtime restart, public sharing, push, merge or deployment were performed. [User guide and official Google source](../NATIVE_CHAT_IMPORT.md), [full upgrade plan](../NATIVE_UPGRADE_PLAN.md).
