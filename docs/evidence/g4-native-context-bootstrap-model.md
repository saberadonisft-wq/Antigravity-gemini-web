# Native context bootstrap model

Date: 2026-10-18. User requirement: use **3.8 Flash only to load initial context**, then use the original processing model. Source: native revision 30 / browser worker fingerprint 22. The main owner is still revision 29 / worker 21; the final update has not been loaded while the user is being asked to complete Google's browser verification. Native-loop acceptance is pending.

## Observed Web controls

[No-Send selection evidence](mcp/native-context-model-catalog-live.json) records the actual menu rows: 3.5 Flash-Lite, 3.8 Flash, 3.1 Pro and 4 Argon. On one disposable owned tab, the probe captured **3.5 Flash-Lite / Low**, selected the exact **3.8 Flash** option, verified it, restored the complete original selection and closed the tab. Zero prompts were sent. The main native owner was restored afterward.

The short picker labels are not full model names: the transport matrix observed “Argon”, while the menu row is “4 Argon”. The implementation reads selected menu rows, including Thinking level when present; it does not invent aliases. A first no-Send inspection failed before the newly created tab mounted its picker; the helper now waits for the picker. [That failure](mcp/native-context-model-catalog-initial-failure-live.json) is retained separately.

## Implementation

- CLI starts with `AG_NATIVE_CONTEXT_MODEL="3.8 Flash"` by default. `AG_NATIVE_CONTEXT_MODEL=off` disables separate context-model staging; `AG_NATIVE_CONTEXT_EFFORT` can explicitly pin a staging effort. This setting is independent of the main Web model and router model policy.
- A full initial native context is staged using exact, random ACKs. Small contexts also use a staging message plus COMMIT; longer text retains lossless fragments. Experimental snapshot staging attaches the complete original UTF-8 file and sends COMMIT separately. Patch follow-ups do not re-enter the initial context-model step.
- Only ACK messages use the context model. MCP captures the selected primary model and effort from the owned conversation before switching. It restores and verifies that selection before publishing each ACK checkpoint. COMMIT explicitly selects that captured primary model; later native turns retain the primary model. Restoring after each fragment adds menu work, but gives every physical receipt a complete restoration boundary.
- A private, metadata-only restoration journal is fsynced before temporary selection. Failure, cancellation or a process crash cannot silently turn the staging model into the primary model: pending restoration blocks new submissions. Browser-open recovery verifies the same account fingerprint, restores the saved primary selection on a fresh owned tab without Send, then removes the journal. Corrupt metadata or a changed account keeps the fence. Recovery never replays the original request.
- A missing 3.8 option, wrong selected model/effort, invalid ACK or missing restoration proof stops the turn. The context model's output is never forwarded as a tool request. There is no account/model fallback or retry of an uncertain Send.

## Native attempt and current live blocker

The [first native 10k text attempt](mcp/native-r29-context-model-text-live.json) failed at model capture/selection with MODEL_UNAVAILABLE, checkpoint/model_selection, **not_sent**. It did not send the staging context or COMMIT. A later [service-level no-Send diagnostic](mcp/native-context-model-service-diagnostic-live.json) reproduced capture failing at open_effort. Its Send method was replaced with an explicit rejecting sentinel, so it could not submit a prompt.

The observer originally re-clicked Thinking level while waiting for the selected option. Revision 30 opens that submenu once and then only observes it; a real Chromium fixture with missing aria-expanded and delayed effort rows verifies that it does not repeatedly toggle the menu. Disabled Thinking controls are not treated as applicable effort settings. This change has fixture validation, not a completed live service validation.

Subsequent browser readiness checks stopped before Send. Read-only CDP inspection found the isolated profile at **www.google.com/sorry/index**, recorded without its query string in [verification-block evidence](mcp/native-context-model-live-verification-block.json). The user has been asked to complete verification directly. No verification bypass, model/account fallback or Send retry was attempted. This later redirect does not establish the cause of the earlier capture failure.

Revision 30 recognizes that exact challenge URL on an already connected browser as BROWSER_USER_ACTION_REQUIRED and preserves the origin restrictions for prompt submission. It does not automate the challenge. Runtime 29's visible browser has been left open while waiting for the user; after verification, load revision 30 and verify fresh synthetic text and attachment loops before claiming the new flow works live.

## Validation boundary

The exact Web option and selection/restore behavior have live no-Send evidence. Targeted fixtures cover 3.8 ACK → exact primary restoration, text/file COMMIT on the primary model, missing restoration proof, restart recovery, changed-account rejection, stale callbacks and corrupt journals. The final observer/challenge changes passed 22 targeted checks (`.tmp/context-model-r30-browser-final-targeted.log`, `.tmp/context-model-r30-final-targeted.log`).

Final source validation: browser **47/47**, MCP **48/48**, native **108/108**, contracts **8/8**; total **211** related package tests. Workspace build and typecheck passed. Logs: `.tmp/context-model-r30-build-final.log`, `.tmp/context-model-r30-browser-full.log`, `.tmp/context-model-r30-mcp-full.log`, `.tmp/context-model-r30-native-full.log`, `.tmp/context-model-contracts.log`, `.tmp/context-model-r30-typecheck-final.log`. [Structured validation record](mcp/native-r30-context-model-offline.json) distinguishes this local evidence from the incomplete Web gate. No real IDE executor, second-account acceptance or remote CI is claimed.
