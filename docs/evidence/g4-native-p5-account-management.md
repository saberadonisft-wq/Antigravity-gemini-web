# P5 — Native account management in the launcher

Date: 2026-10-18. Source: native revision 32 / browser worker 22. P5 is IN PROGRESS. The main owner remains revision 29/manual, with its Google verification window preserved. The new API and UI have not been loaded against the user's live profiles.

## Implemented behavior

The launcher now has **Tài khoản Web / Web accounts**. Opening it reads owner metadata; it does not open Chrome or send a prompt. Explicit controls add an isolated profile, open sign-in, verify identity, select a default account, enable/disable an account, cancel active native turns, unpin a sticky binding, and arm/clear continuation of an exact Gemini conversation URL for a new IDE request. Existing chat stays in the IDE.

The new controls use the existing native owner's authenticated `/__native/manage` API. They do not create a native pool in the launcher. Electron main validates the fixed loopback origin, descriptor/PID and runtime capability, keeps the control token private, refuses redirects, bounds responses and validates the redacted snapshot. The sandboxed preload exposes two narrow methods in addition to the six existing runtime methods. Frame/origin/sender and payload checks still apply. Demo and old runtimes report that management is unavailable; they do not fabricate account readiness or restart the owner.

Mutations require the current owner-instance UUID and account registry revision. UI responses from earlier polls cannot overwrite a completed selection. A stale/disconnected UI locks actions; duplicate clicks do not issue another command. Settings/owner conflicts require a fresh read, with no automatic mutation retry. Profile paths and CDP ports are assigned by the owner, not supplied by the renderer.

Status remains readable while a turn or identity check is running. It distinguishes the selected default from accounts actually serving native requests, reports bounded phases, and retains a busy account until the backend truly settles after cancellation. Cancellation is not recorded as an account-health failure. Stop is reported as confirmed only when the backend confirms it. Resume arms a new request; it never replays an old request.

Identity checks expire after 30 seconds; future-dated observations do not produce a fresh checked state. The UI says identity was checked recently rather than claiming a model or IDE route is ready. Unknown model capabilities stay unknown. Login, traffic verification, identity mismatch, unavailable model, pending model restoration and uncertain outcomes have recovery guidance. IDs, timing, attempt counts and binding hashes are inside the diagnostics disclosure; profile paths, raw identity fingerprints, prompts, replies and tokens are excluded.

CLI `accounts:status` reads the same owner snapshot. Online `account:add` uses the owner API; advanced custom profile/state/port creation remains an offline operation. Existing CLI commands are preserved.

## Validation

- Workspace build PASS: `.tmp/p5-account-r32-build-verified.log`; final launcher build PASS: `.tmp/p5-account-r32-launcher-build-verified.log`.
- Workspace typecheck PASS: `.tmp/p5-account-r32-typecheck-verified.log`.
- Native **132/132**, contracts **10/10**, launcher **40/40** PASS. Logs: `.tmp/p5-account-r32-native-verified.log`, `.tmp/p5-account-r32-contracts-verified.log`, `.tmp/p5-account-r32-launcher-verified.log`. Total in these packages: **182**.
- [Validation manifest and source hashes](mcp/native-r32-account-management-offline.json) record the final checks and read-only observation of the unchanged revision-29 owner.
- [Electron account-control acceptance](p5-native-accounts/native-accounts-desktop.json) PASS: actual Electron, sandboxed preload, IPC, owner HTTP and native registry; browser behavior is synthetic. It exercises selection, identity enrollment, a Google-verification-shaped error, add/enable/disable, resume without replay, busy controls and cancellation. The synthetic backend observes one open, three identity checks, one cancelled generation and **zero Google requests**.
- Rendered artifacts were inspected: [Vietnamese/light](p5-native-accounts/accounts-light.png), [English/light with a stored dark preference](p5-native-accounts/accounts-english-light.png), [800px layout](p5-native-accounts/accounts-800px.png), [verification error](p5-native-accounts/accounts-verification-required.png). No horizontal overflow at 1280/800 CSS px, visible controls at least 44px tall, keyboard traversal and enabled visible button contrast above 14:1 passed. This is not a full WCAG or mobile audit.
- Reproduce the isolated account fixture with `npm run test:desktop-accounts` after build. It uses temporary profiles and a synthetic native backend; it does not touch the user's native owner or Google window.

The first account desktop run failed with `UnknownVizError` during hidden-window capture. Capture now waits for two valid frames and keeps the window hidden. Later visual inspection caught stale compositor images and a contrast measurement that included controls inside a collapsed disclosure. The final capture/contrast checks use settled animations and rendered controls; thresholds were not lowered. These are test-harness corrections, not evidence of a repaired Google/browser interaction.

The initial legacy desktop regression expected exactly the original six preload methods and rejected the two newly declared methods. Its whitelist was updated to exactly eight; a new negative assertion confirms the normal desktop fixture cannot call a native account owner. The historical G4 evidence directory is preserved; this milestone's regression output uses a separate folder.

The final [legacy desktop regression](p5-native-accounts/regression/desktop-smoke.json) PASS includes the previous IPC, renderer, dialog and lifecycle scenarios. Log: `.tmp/p5-account-r32-desktop-regression-verified.log`. Its synthetic browser and unverified native-inference boundary are unchanged.

## Remaining acceptance

The passing Electron fixture does not prove two signed-in Google accounts, real model availability, actual browser Stop, the 3.8 staging → processing-model native loop, or source editing/tool execution by the IDE. Full CLI/launcher restart, expired-result recovery, live account/session failure and migration/rollback/soak gates remain open. Legacy launcher runtime views remain separate from this account-management surface; this milestone does not certify their old native-inference capability flags.

P1/P2 still need real A ↔ B and IDE executor evidence. P3 stability, P4 live failover, P6/P7 and P8 remain open. No remote CI, commit, push, deployment, live owner reload or automatic routing enablement was performed here.

Follow-up: source 33 adds [process restart, actual CLI and real 10-minute cache expiry evidence](g4-native-p5-lifecycle-cache-expiry.md). This supersedes the fixture-only restart/cache gap above; real Google, IDE execution and production recovery/rollback gates remain open.
