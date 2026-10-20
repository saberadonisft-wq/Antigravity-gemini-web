# P7b: account-bound local chat import preview

Date: 19/10/2026. Baseline `7bbeb92`. Native source **38**, browser worker **24**. Status: **PASS local preview; Google import and the rest of P7 IN PROGRESS**.

## Behavior

The launcher adds History import in Vietnamese/English. A user selects an explicitly registered destination identity and declared ChatGPT/Claude provider, then selects one ZIP through Electron main. The sandboxed renderer passes account/epoch and owner/config revisions, never paths, archive bytes or upload URLs. Main rechecks authority before the picker; Native rechecks it after selection. A cancelled picker creates no job. Knowledge and ZIP selection share a single-dialog guard.

Authenticated loopback `POST /__native/imports` is experimental and disabled by default. It requires Native 38 and `AG_NATIVE_IMPORTS_EXPERIMENTAL=1` at owner startup. The launcher only connects to the existing owner. Local inspection uses a dedicated worker thread with bounded VM heap, throttled progress and no inherited Node startup options. It does not call the Native generation backend or browser.

The owner retains at most eight session-only previews and one active worker. It publishes a result only after the actual worker exits successfully. Cancel, target invalidation and expiry cannot release that slot early or publish a late result. Account registry/identity changes withdraw prior previews; TTL is 15 minutes on monotonic time. Cancel remains available while the Native core is busy. Shutdown waits for physical worker exits, has a five-second bound and still attempts import cleanup if the backend close fails. Removing a preview never deletes the original file.

Status contains aggregate ZIP metadata and a leaf filename only; paths stay private in owner RAM. No job survives proxy restart. `ready` means local directory inspection, with CRC/Google compatibility still unverified. No upload command, browser import adapter or transfer receipt is exposed. Existing anti-replay receipts/fences are untouched.

## Validation

Fresh workspace build, typecheck and lint PASS. **436 tests PASS**, zero fail/skip/cancelled: contracts 13, browser 47, MCP 52, bridge 4, Native 186, runtime 80, launcher 54. Thirteen added tests cover actual worker completion/cancel/shutdown, bounded retention/expiry/epoch invalidation, authenticated HTTP/default-off behavior, cleanup despite backend close failure, old-owner/runtime rejection, main-only path transport, IPC frame/arity/payload rejection and renderer poll/mutation races.

Actual Electron acceptance PASS using production sandbox/preload, Native HTTP and a real ZIP worker. Registered identities and chooser grants are synthetic, explicitly labeled in the [result](p7b-native-imports-r38/native-chat-import-desktop.json). It verifies renderer path rejection before any job, picker cancellation, A-preview withdrawal on account selection change, explicit B inspection, metadata-only IPC and no Native generation. Vietnamese and English light-theme screenshots at 1280 and the 800 px layout were visually inspected; no horizontal overflow, minimum 44 px interactive targets, keyboard navigation and zero renderer errors were observed.

The [knowledge regression](p7b-knowledge-regression-r38/native-knowledge-desktop.json) passes against source 38 with real Electron/IPC/HTTP and synthetic browser/chooser grants. The [general desktop regression](p7b-desktop-regression-r38/desktop-smoke.json) passes runtime UI/settings/subscription/export/lifecycle checks; it does not prove Native inference. Logs are `.tmp/p7b-{build,typecheck,lint,all-tests,desktop,knowledge-regression,desktop-regression}.log`. [Source/build/artifact hashes](mcp/native-r38-chat-import-preview-offline.json).

## Remaining gates

No real Google prompt/upload/import or main runtime restart was performed. Real OS chooser selection, account-specific live import eligibility, pre-upload file revalidation, explicit transmission review, durable receipt/fence, partial/unknown recovery and history/attachment fidelity remain open. Memory-text import and P7's Share/Continue, Custom apps and Deep Research/Canvas branches are also still in scope. No Gemini A to B migration is claimed.

The prior P8 recovery evidence remains historical for `51d2542` and its lockfile. P7a changed dependencies and P7b changes Native revision/API; final-release rollback acceptance must independently install and record baseline/current lockfiles. This increment does not close Chrome/DOM soak, Windows restart, full IDE executor, real account handoff or production gates. No push, merge or deployment. [User guide](../archive/guides/NATIVE_CHAT_IMPORT.md), [complete plan](../archive/plans/NATIVE_UPGRADE_PLAN.md).
