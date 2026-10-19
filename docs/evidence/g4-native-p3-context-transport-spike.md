# Native P3 — Context transport investigation and upload spike

Started: 2026-10-16; updated 2026-10-18. Current source: native revision 30, browser worker fingerprint 22; live main owner remains 29/21 while awaiting browser verification. P3 is IN PROGRESS. Snapshot attachment transport remains experimental and disabled by default. Revisions 24–28 below are historical observations, not evidence that all current gates pass. Revisions 29–30 add the user-requested 3.8 context model; see [context model evidence](g4-native-context-bootstrap-model.md).

## Current evidence

- Native/MCP/browser now expose bounded structural transport traces: message index/count, kind, prompt size/hash, response size/hash, ACK result and input/readback/click/acceptance facts. No prompt or raw response is persisted in a trace.
- The adapter marks an uncertain click only at the actual dispatch boundary. A proven pre-click failure reports not_sent and can release the logical reservation. An attempted click with no acceptance remains fenced.
- All four real text sizes failed in this run. No intermediate response was forwarded as a native tool call; no failed fragment was automatically resent.
- A separate real upload spike read all three Unicode markers from an 80,102-character / 80,114-byte text attachment. It used a 307-character controller prompt. The owned tab and local temporary file were cleaned up and the native service restored.

## Text matrix

[Native trace evidence](mcp/native-r24-context-matrix-live.json) was produced by `tools/probes/native-context-matrix.mjs`. Each case has its own synthetic IDE task; no real workspace data or credentials were sent.

| Full wire chars | Observed failure | Evidence boundary |
|---|---|---|
| 28,000 | SEND_NOT_CONSUMED on the first message | DOM readback verified; click attempted; no acceptance observed; not proof that Gemini received the entire prompt |
| 78,642 | CONTEXT_FRAGMENT_ACK_FAILED on fragment 2 | Both fragment DOM readbacks verified and acceptance observed; first ACK matched, second did not |
| 145,000 | SEND_NOT_CONSUMED on fragment 2 | First ACK matched; second message had verified DOM readback/click but no acceptance |
| 261,000 | CONTEXT_FRAGMENT_ACK_FAILED on fragment 2 | Both fragment DOM readbacks verified and acceptance observed; second response did not contain an ACK |

Read-only inspection, restricted to these owned synthetic test chats, found two canonical general-error replies of 69 and 91 characters. Neither contained an ACK token or a native response envelope. The old problem cannot be explained solely as truncation of text input. The run does not prove whether Gemini's general error came from model capacity, provider availability, repetition filtering or account limits. It does not establish the request bytes accepted at Google's server.

A diagnostic-only `known_error_text` classifier was added after that matrix observation and covered by regression fixtures. The original live matrix does not contain that later category field; it was not rewritten to pretend otherwise. This classifier never accepts an invalid ACK, retries a request, changes model or fails over accounts.

## Upload spike

[Sanitized upload retrieval evidence](mcp/native-r24-upload-marker-spike-live.json) records the actual result. The spike pauses an idle native owner, acquires the same OS browser ownership scope used by MCP, attaches only to the verified account/profile and creates a disposable owned tab. It does not run a second browser controller alongside the existing owner.

The real UI exposed Upload & tools → Upload files. The active menu provided one `.cdk-overlay-pane images-files-uploader input[type=file][accept*=".txt"]`; assigning the generated synthetic file through DOM.setFileInputFiles created an uploader-file-preview chip.

The filename is sometimes only an ARIA description/tooltip, not visible filename text. The probe resolves that description to the visible file-preview trigger. Hidden tooltip text alone does not prove attachment readiness. It waits for the matched preview's progress indicator to disappear and checks that no file-error icon is present before sending.

The short prompt contained no marker values. Gemini returned the exact start/middle/end markers, including Vietnamese characters and an emoji. This proves retrieval for that synthetic file on that account at that time. It does not yet prove retrieval of tool schemas/instructions from a compiled native snapshot, a native tool/functionResponse loop, patch/delete semantics across file context or ten stable long-context rounds.

The [Google upload documentation](https://support.google.com/gemini/answer/14903178?hl=en) describes supported uploads and account-dependent limits. It also explains that large files can lose details when they exceed usable context. Its limits are not a reason to increase the native context cap.

## Native integration — revision 25

`NativeSnapshotAttachmentSchema` accepts only versioned text content, a matching hash-derived filename and SHA-256. It rejects arbitrary paths, unknown fields, malformed Unicode and content beyond the existing 262,144-character cap. MCP and the browser verify the actual UTF-8 digest before receipt reservation or browser mutation. Attachment content participates in duplicate identity; durable receipts and traces contain no file content.

The live adapter requires a pinned account fingerprint and an exact conversation lease. The driver selects one text input inside an active visible upload overlay, creates a private temporary file, waits for the exact filename's preview to finish processing and checks the account throughout. At Send, it checks the attachment inventory and readiness again. Timeout, cancellation, upload errors, duplicate controls, changed account and changed chip cannot click Send. Temporary-file cleanup removes only the exact generated file and empty directory, with bounded Windows lock retries. A failed upload retires its lease; it cannot reuse an old context checkpoint containing a draft attachment.

`AG_NATIVE_ATTACHMENT_TRANSPORT=1` explicitly opts a new native runtime into this transport above 28,000 wire characters. Small follow-ups continue through text. `nativeSnapshotAttachmentSupported` reports implementation support, not per-account live acceptance. `snapshotAttachmentExperimental` reports the native opt-in. There is no automatic retry, fallback to fragments, model switch or account failover on an attachment failure.

The acceptance harness `tools/probes/native-snapshot-matrix.mjs --live` stops only an idle, ownership-verified main proxy, runs a temporary proxy with isolated metadata and restores the previous transport setting afterward. It sends only synthetic system/context/tool declarations. It does not exercise the real IDE executor.

### Live native results

[Initial snapshot matrix](mcp/native-r25-snapshot-matrix-live.json): all three initial native tool requests failed. All had exact controller readback, a Send click and observed browser acceptance; all used a single 798-character controller plus the complete text attachment.

| Snapshot chars / UTF-8 bytes | Total elapsed | Observed reply | Native outcome |
|---|---|---|---|
| 78,642 / 78,654 | 15.055 s | 59-character non-protocol text; original contents were not captured | TOOL_REQUIRED |
| 145,000 / 145,012 | 38.471 s | 324-character nonce-bound final envelope, although the request required a tool | TOOL_REQUIRED |
| 261,000 / 261,012 | 30.898 s | 69-character known generic Web error | TOOL_REQUIRED |

Separate new synthetic diagnostic tasks at [78k](mcp/native-r25-snapshot-diagnostic-live.json) and [145k](mcp/native-r25-snapshot-diagnostic-145k-live.json) captured generic Web error replies (65 and 69 characters) in local debug files. They were new task IDs, not replays of the failed requests. The extra 65-character error wording was added to the diagnostic-only exact-text classifier afterward; the original evidence category remains `other` and has not been rewritten.

These results prove browser upload/processing/acceptance for these samples. They do not prove that Gemini used the entire file, obeyed its tool schema, or preserved native context semantics. No tool was forwarded; no functionResponse, final follow-up or replace/delete stage ran because the first required tool failed. The root cause of the provider's generic error remains undetermined. The Web model label was not reliably captured, so these samples cannot establish model-to-model performance or an account limit.

The owner harness restored native revision 25 with experimental transport off after each run. Final owner verification at 2026-10-16T15:26:38Z observed Default Account, epoch 1, with no prompt sent; health showed PID 11912, active 0 and experimental upload false. P3 has not passed its live gate.

The extra generic-error wording was compiled after that restore. A subsequent compound shell command to restart the main owner was rejected by automatic approval review with only `blocked by policy`; it did not execute. That diagnostic-only addition has source/build/fixture validation but is not claimed to be loaded in the still-running main proxy. The snapshot implementation itself was exercised in the revision 25 live probes.

## File lifetime and later native observations — revisions 27–28

A local real Chromium File API [controlled probe](mcp/native-file-retention-local-spike.json) stored the File object on input change and read it only when Send was clicked. Removing its backing file before Send caused NotFoundError; retaining it preserved every byte. This demonstrates a late-read failure class, not the cause of the earlier Gemini generic errors.

The unchanged early-delete revision 27 passed a [complete 78k native loop](mcp/native-r27-early-delete-baseline-live.json) on 17/10: exact tool markers, functionResponse/final, and replace/delete/tool-schema update. This control contradicts a claim that early deletion necessarily explains every previous failure.

Revision 28 keeps a private file lease through the entire browser response. It removes the exact file after completion, confirmed Stop or owned-target closure. A cancellation/timeout with unsettled generation retains the file and metadata ticket until safe cleanup is possible. Real CDP fixtures now delay File.text() until Send, and cover timeout, uncertain clicks, Stop and target closure. Uncertain adopted targets and process-crash orphan cleanup remain P8 work; no blanket claim that every orphan has been removed is made.

[Revision 28 native matrix](mcp/native-r28-retained-file-matrix-live.json), 18/10:

| Initial context chars | Result |
|---|---|
| 28,000 text | CANCELLED / not_sent during cold browser startup, 10.070 s; no Send trace |
| 78,642 attachment | Exact tool markers at 117.655 s; functionResponse follow-up failed SEND_NOT_CONSUMED / unknown at 15.973 s; no retry |
| 145,000 attachment | All three stages passed: 74.154 s tool, 5.395 s functionResponse, 90.428 s replace/delete/tool update |
| 261,000 attachment | All three stages passed: 9.626 s tool, 5.428 s functionResponse, 52.680 s replace/delete/tool update |

All successful marker checks include Vietnamese text and emoji. [Picker observations](mcp/native-r28-retained-file-model-observations-live.json) captured the short label Argon after the attachment replies; full model/effort was not pinned for that matrix. Synthetic caller → real Gemini Web evidence is not real IDE executor acceptance. These two successful sizes do not establish ten stable rounds, and the 78k follow-up Send failure remains open. No Google-side root cause or performance comparison between models is claimed. Native revision 28 was restored with upload off after the matrix.

## Validation and open work

- Workspace build PASS (`.tmp/p3-snapshot-build-final.log`); final native build PASS (`.tmp/p3-snapshot-native-build-final.log`). Workspace typecheck PASS (`.tmp/p3-snapshot-typecheck.log`).
- Contracts 8/8 PASS (`.tmp/p3-snapshot-contracts.log`), browser 43/43 PASS (`.tmp/p3-snapshot-browser-final.log`, including real CDP upload/error/cancel/account-change fixtures), MCP 36/36 PASS (`.tmp/p3-snapshot-mcp.log`), native 87/87 PASS (`.tmp/p3-snapshot-native-final.log`). Total: 174 relevant package tests. Whitespace check PASS (`.tmp/p3-snapshot-diff-check-final.log`); probe syntax checks PASS. This is not a claim about all repository/desktop/remote CI checks.
- First P1/P2 safety validation remains in [revision 23 evidence](g4-native-p1-p2-safety-validation.md). Two-account live acceptance is still waiting for the user to sign into Secondary Account; the user cannot do that currently. This does not block independent P3 work.
- File-lifetime source validation: browser 46/46, MCP 45/45 and native 104/104; workspace build/typecheck passed (`.tmp/p3-file-lifetime-*-final.log`). Later context-model integration has its own [validation record](g4-native-context-bootstrap-model.md).

Next implementation requirements:

1. Implemented: strict content-based snapshot contract, verified hash/Unicode/cap and no caller file paths.
2. Implemented and covered by fixtures: owned-target upload, exact filename readiness, duplicate inventory/control checks, timeout, abort, cleanup and account checks before upload/Send.
3. Implemented: native/MCP/browser integration behind explicit experimental opt-in. Keep the default transport unchanged until acceptance is complete.
4. Revision 28 passed full loops at 145k/261k, but 78k follow-up Send and 28k cold startup still failed. Investigate these separately from generic provider errors without relaxing nonce/schema validation. Revision 29's 3.8 staging → captured primary model also needs native acceptance.
5. Run ten stable long-context rounds on a declared account/model configuration before considering upload a default. The new full menu-row/effort capture supports that declaration; previous short-label observations are retained with their narrower boundary.
6. Investigate unconsumed Send separately from general error replies. Geometry/hit testing and UI readiness are candidates to test, not established causes. A browser extension shadow root appeared during one UI probe; no controlled causal test was performed and no extension setting was changed.

P4–P8 remain in scope. P4 now has SQLite physical receipt migration and experimental routing; failover is still open. Launcher/CLI integration, knowledge adapters, supplementary jobs and release/recovery acceptance remain required. This spike does not mark those phases complete.
