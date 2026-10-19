# Native P1/P2 safety remediation — revision 23

Date: 2026-10-16. Native runtime: 23. Browser worker fingerprint: 15.

Status: LOCAL REGRESSION PASS; real single-account tool loop PASS. P1/P2 two-account live acceptance and native IDE executor acceptance remain pending. This evidence supersedes the acceptance claims in the initial P1/P2 fixture reports.

## Defects reproduced before the patch

Adversarial probes against the prior compiled implementation reproduced:

1. Account A's uncertain request reached a second synthetic backend after proxy restart and selection of B. The original global logical identity was lost across the per-account replay fences.
2. A slow account:disable body passed the first idle guard, then disabled A while a generation was preparing. The turn plan recorded A, while pool.generate selected B. Both HTTP requests returned 200.
3. Readiness accepted both an unregistered identity and a missing observed identity despite an expected fingerprint.
4. Disabling the last account wrote an empty activeAccountId rejected by its own loader. A zero CDP port could likewise be saved and make restart fail.
5. A stale registry instance returned C from add(), but saved only A/B after reloading during the mutation.
6. Windows profile names differing only by letter case and a shared state directory were accepted.

These were isolated synthetic probes, not duplicate prompts sent to real Gemini.

## Current implementation

- Registry updates acquire an exclusive writer lock, reload current data, change a cloned draft, validate it and commit atomically. Reads do not depend on mtime. Selection revisions reject stale controls. Empty selection is valid only with no enabled account; ensureDefault never re-enables disabled accounts.
- Profile/state paths must be separate, non-overlapping and free of links/junctions; Windows case aliases conflict. Invalid names, ports and oversized registries fail before persistence.
- Each native turn captures its backend once. Account control repeats the busy check after reading the HTTP body. Verification/opening reserve the owner control operation; a generation cannot begin during it.
- Account enrollment is explicit via account:verify. The fingerprint hashes a single normalized email, not a display name/avatar URL/localized label. Missing/ambiguous identity is unverified. Enrollment compares the identity epoch under the registry lock.
- Native workers prove the browser at the CDP port uses their profile. Automated Chrome exposes its command line; legacy Windows Chrome is checked against the listening process and configured executable/profile. A foreign profile is rejected before opening a page in it.
- The expected fingerprint travels through native → MCP → browser and is checked before the actual Send click. A browser-proven pre-click rejection reports not_sent; it cannot become an uncertain accepted Send.
- Bindings include task/account/identity epoch/surface. A pending/uncertain turn fences its IDE conversation across accounts, while independent IDE chats remain separate. Callback completion rechecks pinned account authority.
- A hash-indexed logical metadata ledger reserves each request before browser work. Restart and account selection do not remove the reservation. Only proven not_sent can release it; stale attempts cannot delete or complete a new reservation. No prompt/result is persisted there.
- Conversation metadata migrates v1 → v2 only after validation and a private .v1.backup. Missing account remains unbound. Explicit recovery uses a new follow-up; the old context revision stays retired/fenced after recovery.
- Explicit resume captures account and epoch. Changing account after arming resume fails rather than applying its URL to another account.

## Validation

| Check | Evidence |
|---|---|
| Workspace build | PASS; .tmp/p1-p2-safety-build.log |
| Workspace typecheck | PASS; .tmp/p1-p2-safety-typecheck.log |
| Contracts | 8/8 PASS |
| Native | 84/84 PASS; .tmp/p1-p2-safety-native-final.log |
| MCP | 34/34 PASS; .tmp/p1-p2-safety-mcp.log |
| Browser before strict-profile addition | 36/36 PASS serial; .tmp/p1-p2-safety-browser-serial.log |
| Browser final | 37/37 PASS; .tmp/p1-p2-safety-browser-final.log |
| Logical metadata store | 2,100 reservations/completions; early/middle/late lookups remain fenced after restart; no prompt fields persisted |
| Real account verification | Default Account registered at epoch 1; no prompt sent by verification |
| Real Web tool loop | [single-account evidence](mcp/native-r23-account-single-live.json): two native requests PASS; tool marker and functionResponse/final marker correct; full → patch |

The 2,100-record logical-store fixture took 18,397 ms in that run. This is one local observation under concurrent tests, not a latency benchmark or proof that the MCP physical receipt store has migrated.

The first browser suite run passed its functional assertions but failed owned fixture cleanup with Windows EBUSY on segmentation_platform/ukm_db-wal. It is retained at .tmp/p1-p2-safety-browser.log. The isolated account-change test then passed, followed by 36/36 in a serial full run. A strict-profile fixture additionally needed a positive DOM-loaded checkpoint and direct byte verification of its preserved draft; its final full run is recorded separately. The initial failure is not hidden as a first-pass success.

## Runtime and remaining gates

The owned runtime was advanced from idle revision 22 to 23. Default profile was verified without copying cookies or changing the Google account. A Secondary Account profile/state/port 9224 was created and opened for manual sign-in; Default Account remains selected.

The real single-account test used synthetic history and verify_context, under the model selected in Web. It did not execute IDE view_file/write/run_command and does not establish A ↔ B live acceptance.

P1/P2 cannot be labeled fully accepted until both real profiles are signed in, verified and the handoff probe passes. The upgrade plan retains P3–P8. P4 physical receipts remain capped at 2,048; manual/priority routing, failover and physical-ledger migration are pending. P5 launcher controls and native IDE executor acceptance are pending. Registry locks left by a crashed writer fail closed and require inspected recovery; automated stale-lock recovery remains a P8 item.


Subsequent work: runtime 24 / browser worker 16 adds P3 structural trace diagnostics. See [P3 evidence](g4-native-p3-context-transport-spike.md); it does not change the pending P1/P2 live gates. The user confirmed that a second-account sign-in cannot be completed currently.
