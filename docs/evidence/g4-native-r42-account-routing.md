# Native 42: account routing and model-selector diagnostics

Local validation recorded 19/10/2026. This evidence covers source/build and synthetic browser fixtures; it does not certify a live Gemini account or native IDE tool execution.

## Changes

- The launcher exposes **Manual** and **Sticky per chat** account policies. Sticky mode binds a new IDE task to the account selected for its first turn, then preserves that account for later turns. Selecting another default affects new chats. This mode does not fix or change the Gemini Web model.
- Routing mutations carry both owner revision and routing revision. Sticky is available without the experimental router flag; priority, round-robin, and failover remain gated and require an explicit fixed Web model policy.
- The account page displays a sanitized model-selector rejection, including received and expected selectors. The launcher requires Native runtime revision 42 for the updated account-management contract, and reports an update-required state for older owners.

## Validation

- `npm run build` — PASS.
- `npm run typecheck` — PASS.
- Contracts tests — 14/14 PASS; Native tests — 197/197 PASS.
- Affected launcher owner-client tests — 9/9 PASS after updating the runtime-version fixtures; account-store tests — 6/6 PASS.
- Electron account-management smoke — PASS on runtime revision 42. It used a synthetic browser and made zero real Google requests; it checked account controls, routing policy selection, pairing UI, cancellation, keyboard navigation, 800/1280px layouts, contrast and renderer errors.
- Fixed an initial-navigation race in composer readiness: CDP may connect while its owned target still reports `about:blank`; the driver now waits for that target to commit while still rejecting unsupported origins immediately. The isolated transition and import-surface tests pass.
- `npm test` — PASS, 461/461 across contracts 14, gemini-browser 56, MCP server 53, model bridge 4, Native 197, runtime 80, and launcher 57.
- `git diff --check` — PASS (Git reports only the repository's existing LF-to-CRLF working-copy notices).

## Live boundary

The existing Native owner was read at runtime revision 41 with no active account leases. Stop and relaunch it after current work is settled before this launcher/source can use the revision-42 management contract. The source has not been validated with two real Google profiles, an IDE executor, or a live A → B → A chat.
