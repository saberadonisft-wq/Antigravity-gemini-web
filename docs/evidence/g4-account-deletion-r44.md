# Account deletion recovery, revision 44

Date: 2026-10-20.

The reported `Default Account` deletion failed even with continuation retirement selected. Inspection found that already-retired conversation records were still returned as browser resources to release. Retrying removal therefore called the unavailable old broker again. Separately, launcher removal used the five-second status deadline: the real account deletion completed, but its response exceeded that deadline and the launcher reported `RUNTIME_DISCONNECTED`.

Changes:

- Exclude retired conversation records from browser cleanup. Keep their durable replay fences.
- Allow a faulted MCP broker to dispose owned conversations after an operation settles. Submissions remain blocked; active operations still block cleanup.
- Give account removal a 30-second launcher deadline.

Validation:

- Native build and all 205 tests passed. The deletion regression fails worker shutdown after chat retirement, then verifies that retry removes the account and managed storage without re-releasing retired leases.
- MCP build and all 54 tests passed. A terminal receipt-write failure still allows lease disposal, while new submissions remain refused.
- Launcher build and 16 owner-client/account-store tests passed, including a real loopback deletion response delayed by 5.5 seconds.
- Electron account controls passed at revision 44: real preload, IPC and loopback owner; synthetic browser, zero Google requests and zero renderer errors. Output is in `.tmp/account-delete-r44-desktop/`.

Live local result:

- Restarted the idle Native runtime into revision 44, then removed `Default Account` through the authenticated management API.
- Confirmed the registry contains only `gemini1` and `gemini2`; their registry records were unchanged.
- Confirmed both legacy bridge-managed directories for `Default Account` were absent after removal.
- The original five-second launcher client timed out during that successful deletion. The deadline fix and delayed-response regression were applied afterward, and the updated launcher was started.

This verifies local account deletion and launcher controls. It does not constitute new live Gemini inference, account switching or IDE tool-loop acceptance.
