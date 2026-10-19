# G4 Native P1 — Account Registry and Isolated Workers Validation

> Superseded acceptance status: subsequent adversarial probes found replay, identity, worker routing and registry defects. See [revision 23 safety validation](g4-native-p1-p2-safety-validation.md). This document is historical fixture evidence; P1/P2 live gates remain pending.
Date: 2026-10-16. Baseline: native revision 22, browser fingerprint 13.

## 1. Verified Architecture & Design Findings

Investigation of multi-account operation for native Antigravity IDE chat:
- Switching Google accounts inside a single browser profile causes race conditions, invalidates cached conversation URLs, risks cookie leakage between identities, and triggers `ACCOUNT_IDENTITY_CHANGED`.
- To maintain a single native chat in Antigravity IDE while using multiple accounts:
  1. Each account must own an isolated browser profile directory (`profilePath`), state directory (`statePath`), CDP debug port (`debugPort`), and identity fingerprint.
  2. An `AccountRegistry` maintains versioned account metadata on disk (`accounts.json`) with collision checks against reused profile paths or colliding CDP ports.
  3. A `NativeBrowserBackendPool` routes requests to the active account's dedicated browser worker without restarting other account workers.
  4. Zero-migration default: `ensureDefault()` automatically adopts the existing live profile path (`~/.gemini/antigravity-gemini-web-live/app_data/browser_profile`) and state path (`.../mcp`) with port 9223. No cookies are moved, copied, or touched.
  5. Account identity verification: avatar and profile information detected from the Gemini Web DOM (`DomInspectionResult.accountIdentity`) is compared before Send against `expectedIdentityFingerprint`. If a profile is switched to a different identity, the request is rejected with `ACCOUNT_IDENTITY_CHANGED` at `phase: "checkpoint"` with `delivery: "not_sent"`.
  6. Disabling an account (`disable()`) preserves conversation state, history, and cache; files on disk are never deleted or unlinked.

## 2. Changes Made

### Contracts (`packages/contracts/src/account.ts`)
- Defined versioned schemas:
  - `AccountRecordSchema`: `accountId`, `displayName`, `profilePath`, `statePath`, `debugPort` (1024-65535), `identityFingerprint?`, `enabled` (default true), `capabilities`, `createdAt`, `updatedAt`.
  - `AccountRegistryFileSchema`: `version: 1`, `activeAccountId`, `accounts: AccountRecord[]`.
  - `AccountRuntimeStateSchema`: runtime status (`signed_in`, `unverified`, `identity_mismatch`).
- Exported from `@antigravity-gemini-web/contracts`.

### Account Registry (`packages/native-antigravity/src/account-registry.ts`)
- Implemented `AccountRegistry` class:
  - Versioned atomic storage using `atomicPrivateFile`.
  - Collision detection: prevents duplicate profile paths (`ACCOUNT_PROFILE_CONFLICT`, 409) and duplicate CDP ports (`PORT_COLLISION`, 409).
  - Automatic port allocation: auto-assigns next free port (starting at 9223).
  - Flexible lookup by `accountId` or case-insensitive `displayName`.
  - Active account management: `setActive()`, `getActive()`. Disabling the active account automatically selects the next enabled account.
  - Hot reloading: tracks file `mtime` so CLI commands in other processes immediately reflect in the running proxy.
  - Zero-migration `ensureDefault()`: adopts existing directory layout without touching cookies or moving folders.

### Browser Backend Pool (`packages/native-antigravity/src/browser-backend-pool.ts`)
- Implemented `NativeBrowserBackendPool` implementing `NativeBrowserBackend`:
  - Maintains a map of `McpNativeBrowserBackend` keyed by `accountId`.
  - Passes isolated environment variables: `AG_MCP_BROWSER_PROFILE`, `AG_MCP_STATE_DIR`, `AG_MCP_DEBUG_PORT`, and `expectedIdentityFingerprint`.
  - Enforces `account.enabled` before delegating.
  - Supports targeted `openBrowser(accountId?: string)`.
  - Closes all workers cleanly on shutdown.

### Browser Readiness & Identity Enforcement (`packages/native-antigravity/src/browser-readiness.ts`)
- Enhanced `ensureNativeBrowserReady`:
  - Supports both string fingerprints and structured `AccountIdentitySnippet` objects from DOM inspection.
  - If `expectedIdentityFingerprint` is set and does not match observed fingerprint, throws `ACCOUNT_IDENTITY_CHANGED` with `phase = "checkpoint"` and `delivery = "not_sent"`.

### Native Proxy & Health Endpoint (`packages/native-antigravity/src/native-proxy.ts`)
- Integrated `accountRegistry` into `NativeProxyOptions`.
- `GET /__native/health` exposes active account summary (`accountId`, `displayName`, `debugPort`, `identityVerified`).
- Added authenticated owner control route `POST /__native/account` with actions: `use`, `disable`, `enable`, `list`.
- Updated `POST /__native/browser` to accept optional `accountId`.

### CLI Tooling (`packages/native-antigravity/src/native-cli.ts`)
- Added account management CLI commands:
  - `accounts` / `account:list`: List all accounts, active status, port, and identity status.
  - `account:add <name> [--profile <path>] [--state <path>] [--port <port>]`: Register new account with unique profile/state dirs.
  - `account:use <id|name>`: Switch active account (hot switch via proxy owner control if running, or via disk registry).
  - `account:disable <id|name>`: Disable account without deleting data.
  - `account:enable <id|name>`: Re-enable account.
  - `account:check [id|name]`: Validate paths, port, and identity status.
  - `account:browser [id|name]`: Open browser for specific or active account to log in.
- In `start` command: instantiates `NativeBrowserBackendPool` and connects `AccountRegistry`.

## 3. Verification & Gate Evidence

### Unit & Integration Tests (`packages/native-antigravity/src/account-registry.test.ts`)
- `AccountRegistry initializes empty registry and persists atomic JSON` (PASS).
- `ensureDefault adopts existing profile/state without copying cookies` (PASS).
- `add() rejects profile conflict and CDP port collision, auto-allocates port` (PASS).
- `setActive, disable, enable, and find by id or display name` (PASS).
- `disable account does NOT delete chat history or state files` (PASS).
- `AccountRegistry reloads on external disk change` (PASS).
- `NativeBrowserBackendPool isolates workers by profile, port, and identity` (PASS).
- `Identity mismatch in profile throws ACCOUNT_IDENTITY_CHANGED before Send` (PASS).
- `Health endpoint exposes active account summary and control switches account` (PASS).

### Test Suite Execution
- `@antigravity-gemini-web/native-antigravity`: 66/66 tests PASS.
- `@antigravity-gemini-web/mcp-server`: 33/33 tests PASS.
- `@antigravity-gemini-web/gemini-browser`: 35/35 tests PASS (including real CDP fixtures).
- Total verified tests: 134/134 PASS.

### Live CLI Verification
- `node packages/native-antigravity/dist/native-cli.js accounts` executed:
  Returned `Default Account` active on port 9223 with existing profile path.
- `node packages/native-antigravity/dist/native-cli.js account:check` executed:
  Validated profile and state directories exist, identity unverified pending sign-in.

## 4. Gate Assessment

| Criteria | Status | Evidence |
|---|---|---|
| Registry versioned with atomic persistence | SATISFIED | `accounts.json` version 1, `atomicPrivateFile` |
| CLI commands for add/list/check/use/disable/enable | SATISFIED | `native-cli.ts` + `account-registry.test.ts` |
| Profile/state/port isolation per worker | SATISFIED | `NativeBrowserBackendPool` isolates env & CDP ports |
| Zero-migration adoption of existing profile | SATISFIED | `ensureDefault()` verified without cookie copy |
| Port collision and duplicate profile rejection | SATISFIED | `ACCOUNT_PROFILE_CONFLICT` and `PORT_COLLISION` tests |
| Identity mismatch detection before Send | SATISFIED | `ACCOUNT_IDENTITY_CHANGED` at checkpoint, delivery=not_sent |
| Disabling account preserves history and state | SATISFIED | Verified preservation test, no files unlinked |

**Phase P1 is COMPLETE (GATE SATISFIED).**
Ready to proceed to Phase P2 (Binding and A ↔ B synchronization).
