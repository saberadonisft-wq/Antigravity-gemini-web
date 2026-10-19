# G4 Native P0 — Session Recovery and Diagnostics Validation

Date: 2026-10-16. Baseline: native revision 22, browser fingerprint 13.

## 1. Verified Root Cause

Investigation of the failure observed on 2026-10-16:
- Request was performing `persistent_rebind_after_restart` targeting a cached Gemini conversation URL from metadata saved before restart.
- The user had switched Google accounts in the browser profile; the target tab for that old conversation was no longer open.
- The browser was `signed_in` at `/app`, but `openExistingConversation(url)` found 0 matching tabs (`Target.getTargets`).
- `gemini-browser` threw a plain `Error("Open exactly one tab...")` without a structured `.code`.
- `GeminiMcpService.submit()` caught the plain error, falling back to `BROWSER_TURN_FAILED`.
- `native-proxy` correctly identified `phase: "checkpoint"` and `delivery: "not_sent"`, but emitted a generic "Không xác minh được phiên Web" message because specific error codes were missing from the contracts and driver.
- Distinct from the long-context ACK failure: the long-context issue is an independent transport/model acceptance issue that remains under investigation (root cause undetermined).

## 2. Changes Made

### Contracts (`packages/contracts/src/errors.ts`)
- Added specific error codes to `UiErrorCodeSchema`:
  - `ACCOUNT_IDENTITY_CHANGED`
  - `CONVERSATION_NOT_OPEN`
  - `CONVERSATION_NOT_ACCESSIBLE`
  - `CONVERSATION_CHANGED`
  - `SOURCE_NOT_READY`
- Added suggested actions to `SuggestedActionSchema`:
  - `switch_account`
  - `reopen_conversation`
- Added structured `detail` (max 512 chars) to `UiErrorSchema` for bounded diagnostics without leaking sensitive data.

### Browser Driver (`packages/gemini-browser/src/index.ts`)
- Attached structured `.code = "CONVERSATION_NOT_OPEN"` when tab count !== 1 during `openConversation(existingUrl)` while maintaining regex compatibility (`/exactly one/`).
- Attached structured `.code = "CONVERSATION_CHANGED"` when existing conversation URL redirects or changes upon attach.
- Attached structured `.code = "BUSY"` when target conversation has unsent drafts or active generation.

### Browser Backend (`packages/native-antigravity/src/browser-backend.ts`)
- Separated `brokerCode` extraction using nullish coalescing to avoid collapsing specific codes into `BROWSER_TURN_FAILED`.
- Forwarded bounded broker diagnostics (`brokerDetail`) without sensitive prompt or credential values.

### Native Proxy (`packages/native-antigravity/src/native-proxy.ts`)
- Added explicit phase/code-specific error messages in Vietnamese for the checkpoint phase:
  - `CONVERSATION_NOT_OPEN`: "Tab hội thoại không mở; kiểm tra trình duyệt."
  - `ACCOUNT_IDENTITY_CHANGED`: "Tài khoản Gemini đã thay đổi; chọn đúng tài khoản."
- Added `rebindSource` diagnostic field (`persistent_metadata` vs `live_revision` vs `fresh`) to the turn record.

## 3. Verification

### Test Results
- `@antigravity-gemini-web/contracts`: tsc build PASS.
- `@antigravity-gemini-web/gemini-browser`: 35/35 PASS (includes real CDP fixture tests).
- `@antigravity-gemini-web/mcp-server`: 33/33 PASS (includes cancellation, persistence, duplicate rejection).
- `@antigravity-gemini-web/native-antigravity`: 57/57 PASS (includes new P0 test: `Persistent rebind to missing tab after account switch fails with CONVERSATION_NOT_OPEN at checkpoint before Send`).
- Total verified tests: 126/126 PASS.

### Replay Fence and Ownership Preservation
- When `CONVERSATION_NOT_OPEN` occurs, `delivery=not_sent` is strictly preserved.
- `conversations.discardUnsent(plan)` releases the active reservation without sending any browser prompt.
- Durable replay fences are retained; no prompts or tool requests are replayed.
- The user's IDE history remains intact and unaffected by browser rebind failures.

## 4. Remaining Boundaries & Next Phase

- The root cause of the long-context ACK failure (P3) remains undetermined and is tracked separately.
- P0 gate is SATISFIED.
- Dependency for P1 (Account Registry & isolated browser worker/profile/state) is met.
