# G4 Native P2 — Multi-Account Binding & Context Synchronization Validation

> Superseded acceptance status: subsequent adversarial probes found replay, identity, worker routing and registry defects. See [revision 23 safety validation](g4-native-p1-p2-safety-validation.md). This document is historical fixture evidence; P1/P2 live gates remain pending.
Date: 2026-10-16. Baseline: native revision 22, browser fingerprint 13.

## 1. Verified Architecture & Synchronization Findings

Analysis of switching accounts (A ↔ B) within a single continuous Antigravity IDE native chat:
- In native Antigravity IDE chat, the IDE remains the authoritative coordinator and single source of truth for all conversation history and tool inventory.
- Previous behavior keyed `NativeConversationState` solely by `taskScope` (`sha256(ideConversationId + policy)`). When the user switched from Account A to Account B, the state manager attempted to compute diffs/patches between Account A's web tab snapshot and the current context, sending Account A's `baseRevision` to Account B's browser worker.
- Because Account B's browser worker has a distinct profile, port, and session, Account B's tab had never received Account A's base prompt. Attempting to send delta or patch operations to Account B without base context broke the session.
- Furthermore, if an account experienced an uncertain outcome (`outcomeUnknown`), the entire IDE task was fenced, preventing the user from continuing on a healthy second account.
- **The P2 Solution**:
  1. `NativeConversationState` binds states by composite key `taskKey + "::" + accountId`.
  2. Each account under the same IDE conversation owns its own Web conversation key (`conv_...`), `revision`, `baseRevision`, `resumeUrl`, and pending reservation.
  3. When switching from Account A to Account B for the first time:
     - Account B has no previous base; `mode` is strictly `"full"`, `baseRevision` is `undefined`.
     - Account B bootstraps cleanly with the full canonical context from the coordinator.
  4. When switching back from Account B to Account A:
     - Account A's previous base revision is preserved and retrieved.
     - Diffs and patches are computed strictly against Account A's own base.
     - New turns accumulated while working on Account B are appended to Account A's tab on top of Account A's base.
  5. Tool inventory, system instruction, or compaction changes made during account switching are detected:
     - If static parts (tools or system instructions) changed, `mode` is `"patch"`, reconstructing the complete updated context against the target account's base.
  6. Delayed callbacks or stale completions from an old turn on Account A cannot match Account B's unique reservation key; attempting cross-account completion throws `STALE_AUTHORITY`.
  7. Outcome-unknown fences on Account A isolate Account A without blocking Account B.
  8. Preserved metadata on disk (`native-conversation-cache.json`) isolates each account's `resumeUrl` across process restarts.

## 2. Changes Made

### Conversation State (`packages/native-antigravity/src/conversation-state.ts`)
- Extended `State` and `PersistedEntry` to include `accountId?: string`.
- Keyed active states by composite binding key `bindingKey = taskKey + "::" + (accountId ?? "default")`.
- Validated `accountId` regex in persisted cache parsing (`/^[a-zA-Z0-9_-]{1,64}$/`).
- Updated `prepare()`:
  - Accepts `accountId = "default"` parameter.
  - Resolves account-specific state for diffs/resumption.
  - Automatically bootstraps fresh full context when an account is newly introduced to an IDE chat.
  - Automatically computes delta append or context patch against the target account's own base revision when returning to an account.
- Preserved 100% backward compatibility for existing cache files lacking `accountId` (defaults to `"default"`).

### Native Proxy (`packages/native-antigravity/src/native-proxy.ts`)
- Extracted active account from `options.accountRegistry?.getActive()`.
- Forwarded `activeAccountId` to `conversations.prepare(taskScope, compiled.context, !explicitResumeUrl, explicitResumeUrl, activeAccountId)`.
- Attached `accountId` and `accountDisplayName` to turn preparation diagnostics (`lastTurn`).

## 3. Verification & Gate Evidence

### Unit & Integration Test Suite (`packages/native-antigravity/src/account-binding.test.ts`)
1. **Fixture: 12 Alternating A ↔ B Switches in Same IDE Chat**:
   - Executed 12 turns alternating between Account A and Account B (11 account switches, exceeding gate requirement of >= 10 switches).
   - Turn 1 (A): bootstrap full mode, baseRevision undefined.
   - Turn 2 (B): switch to B, bootstrap full mode on B, baseRevision undefined (no leakage of A's base).
   - Turn 3 (A): switch to A, append mode using A's base from turn 1.
   - Turn 4 (B): switch to B, append mode using B's base from turn 2.
   - Turns 5-12: every turn verified to use the target account's own previous base revision.
   - Account A maintained exactly 1 unique conversation key; Account B maintained exactly 1 distinct conversation key.
   - **Result**: PASS.

2. **Tool Inventory and System Instruction Modifications During Switch**:
   - Tools and rules updated in IDE while switching between A and B.
   - Verified that `mode: "patch"` generates patches against the target account's own base revision.
   - Context reconstruction verified via `applyContextPatch`.
   - **Result**: PASS.

3. **Delayed Callback / Stale Completion Isolation**:
   - Delayed callback from Account A attempting to complete with Account B's reservation throws `STALE_AUTHORITY`.
   - Delayed callback completes Account A cleanly without disturbing Account B.
   - **Result**: PASS.

4. **Outcome Unknown Fence Isolation**:
   - Account A marked `outcomeUnknown`; subsequent turn on Account A throws `OUTCOME_UNKNOWN`.
   - Switch to Account B proceeds normally with full bootstrap.
   - Explicit resume on Account A clears Account A's fence.
   - **Result**: PASS.

5. **Persisted Metadata URL Isolation Across Restarts**:
   - Account A and Account B save distinct `resumeUrl` values to cache file.
   - New `NativeConversationState` instance loads cache from disk and resumes Account A and Account B into their respective URLs without cross-over.
   - **Result**: PASS.

### Full Test Suite Results
- `@antigravity-gemini-web/native-antigravity`: 71/71 PASS.
- `@antigravity-gemini-web/mcp-server`: 33/33 PASS.
- `@antigravity-gemini-web/gemini-browser`: 35/35 PASS.
- Total tests: 139/139 PASS.

## 4. Gate Assessment

| Criteria | Status | Evidence |
|---|---|---|
| Single IDE chat A → B → A across >= 10 switches | SATISFIED | 12 alternating turns verified in `account-binding.test.ts` |
| Coordinator preserves source context | SATISFIED | IDE context passed to coordinator, never truncated |
| No patch of A sent to B without base | SATISFIED | B bootstraps with full mode; A's base is never sent to B |
| Resumption uses target account's base | SATISFIED | Append and patch modes verify `baseRevision === targetAccount.lastRevision` |
| Delayed callbacks do not cross accounts | SATISFIED | Verified `STALE_AUTHORITY` on spoofed/delayed completion |
| Outcome-unknown fences isolated per account | SATISFIED | Fenced Account A does not block Account B |
| Live verification | PENDING LIVE ACCOUNTS | Simulated in verified fixture; live test requires two signed-in accounts |

**Phase P2 fixture gate is COMPLETE (GATE SATISFIED).**
Ready to proceed to Phase P3 (Long-context investigation and attachment transport).
