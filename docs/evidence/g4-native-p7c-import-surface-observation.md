# P7c: account-bound import surface observation

Date: 19/10/2026. Baseline `3f42313`. Source Native **39 / browser worker 25**. This adds an existing-tab inspection command, not an uploader or proof of account entitlement. [Quick user test](../archive/guides/NATIVE_TEST_QUICKSTART.md).

## Implementation

`native:imports:check -- ACCOUNT_ID` uses the authenticated Native owner and its account-bound MCP backend. The request carries owner instance, registry revision and identity epoch. It requires the import experiment and an enabled registered identity. Native prevents overlapping account operations, captures the account backend once and rejects a changed account/revision or late result. It does not enroll an identity, generate a Native turn or create a transmission receipt.

The MCP owner advertises `chatImportSurfaceInspectionSupported` and adds read-only `gemini_inspect_import`, taking only the expected fingerprint. The browser inventory is now eight tools; host tools remain four. This is source/SDK discovery, not a fresh real IDE discovery claim. A fingerprint 24 worker cannot silently stand in for fingerprint 25.

The browser inspector uses the existing debug port, verifies the browser profile and reads existing allowlisted non-conversation targets through separate temporary CDP connections. It never launches Chrome, creates/navigates/activates/closes a user tab, clicks Add, writes a file input, pastes memory or sends a prompt. The scan bounds candidate count and elapsed time. Canonical conversation targets and DOM with a composer/model response are excluded.

Positive evidence needs one visible import heading, unambiguous controls and a visible avatar identity matching the expected account. Hidden/duplicate controls, multiple import pages and mismatched/missing identity cannot produce a uniquely verified observation. Results contain booleans, timestamp and an opaque target hash, with no email, URL, chat text or local path. `controls_observed` is a point-in-time observation, not eligibility, Google compatibility, quota or import success. It is not cached as authorization for a future upload.

This increment exposes the probe through CLI/Native/MCP; the launcher still has local ZIP preview only. English heading recognition has actual fixture coverage. Vietnamese patterns and actual Google markup require live comparison. Unsupported/localized/loading screens can return `not_observed`; that does not establish that an account is ineligible. No current transfer adapter, fence or imported-history fidelity is claimed.

## Cleanup defect found during validation

A retained-target test exposed a real close-acknowledgement race: an attached driver closed its own initial tab using that page's CDP socket, which could disconnect before returning the ACK. Cleanup now calls the existing browser-endpoint `closeOwnedTarget` helper and confirms that exact target is absent. It never closes the attached user's Chrome process or unrelated tabs. The regression now explicitly disconnects the page socket first, so the old implementation fails deterministically; the fixed case passes.

## Evidence

The real CDP test runs an owned headless Chrome against local HTML. It verifies a pre-existing draft before inspection and after all cases, unchanged driver connection, hidden/duplicate controls, wrong/missing identity, rejection of chat DOM and ambiguity across two import tabs. Its fixture receives zero prompts. This is actual Chrome/CDP behavior, with synthetic HTML/account identities and no Google access.

MCP tests verify browser admission during a probe, no physical receipt/Send, closed-owner rejection and eight-tool SDK/stdio discovery. Native HTTP tests exercise actual account pool binding, concurrent account-control rejection and stale-result withdrawal without generation. Contract tests reject unsupported transmission claims, identity-free positives, raw URL/email metadata and caller file paths.

Build, typecheck and lint PASS. **440 tests PASS**, zero fail/cancel/skip: contracts 14, browser 48, MCP 53, bridge 4, Native 187, runtime 80 and launcher 54. Results and source/build hashes are recorded in the [manifest](mcp/native-r39-import-surface-offline.json). Four new tests account for the increase from 436. The first pass exposed two test defects (the new tool count and missing initial composer readiness); the next pass exposed the cleanup race above. Logs preserve these failures as `.tmp/p7c-all-tests.log` and `.tmp/p7c-all-tests-rerun.log`. Final acceptance log: `.tmp/p7c-all-tests-final.log`; targeted disconnected-socket regression: `.tmp/p7c-retained-target-fixed.log`.

The [Electron preview regression](p7c-native-imports-r39/native-chat-import-desktop.json) passes with real preload/HTTP/archive worker and synthetic chooser/identity. Its browser is not used. It does not exercise the new CLI surface probe or prove real OS selection/import.

## Remaining gates

No actual Google prompt/upload/import, real OS chooser selection, two-account handoff, full IDE executor or real eligibility result is added by these tests. The default 3.8 Flash staging/primary restoration flow still needs live acceptance. P7 upload revalidation/review/receipt/partial handling, memory-text flow, Share/Continue, Custom apps and Deep Research/Canvas remain in the plan. P6 adapters and P8 soak/Windows/browser/release gates also remain open. The prior 36/38 recovery result belongs to `2804560`; it does not certify arbitrary future builds.

No push, merge or deployment. A proposed local `Start-Process` startup of Native 39 was rejected before execution by automatic approval review with only `blocked by policy` supplied. No fallback startup was attempted. Main health was unavailable and the descriptor PID was absent at the preceding read-only observation; this report does not claim a running main owner. The user can follow the quick test guide in their terminal. [Full plan](../archive/plans/NATIVE_UPGRADE_PLAN.md), [import guide and official Google source](../archive/guides/NATIVE_CHAT_IMPORT.md).
