# Native long-context delivery — 16/10/2026

## Root cause and behavior

The reported Web message contained about 32,000 characters and no closing
`</native_context_json>` tag. A separate synthetic 82,830-character editor probe
also retained only about 32,000 characters and lost its ending marker. This is an
observed editor limit on this profile, not the model's context window.

Native revision **21**, browser fingerprint **12** add:

- Trusted Chromium input, Send/Stop clicks, and two exact logical editor
  readbacks before Send. Clipped or changed input fails before Send.
- A **28,000-character** limit per physical browser MCP message. Complete native
  context retains its **262,144-character** cap. Long native prompts use lossless
  fragments of up to 27,000 characters, each framed below the physical limit.
- One retained conversation and revision chain, exact unique acknowledgements,
  and a separate commit. Intermediate output never becomes IDE text or a tool
  call. Only the committed result reaches nonce/tool/schema/Unicode validation.
- Cancellation of the currently active fragment, no automatic replay, and no
  claim of `not_sent` for the whole request after an acknowledged fragment.
- A cancellable one-second interval after completed browser replies. Immediate
  follow-up Sends had left a full draft unconsumed in live tests.
- Response identity/content checks in addition to counts, for virtualized or
  reused response containers.

## Verification

**118 related tests PASS:** browser 33/33, native 53/53, MCP 32/32. Full workspace
build/typecheck PASS. Tests cover trusted editor state/clicks, asynchronous
clipping without Send, virtualized answers, exact whitespace/Unicode recovery,
maximum-size framing, revisions, rejected ACKs and active-fragment cancellation.
Transport does not persist prompts, results or credentials.

The real-browser probe sends synthetic context and a `verify_context` tool
declaration. It does not execute IDE tools or read workspace files.

| Stage | Observed result |
| --- | --- |
| Full prompt | 78,642 characters; 3 fragments + commit; HTTP 200; 55.65 s |
| Context/tool check | Exact beginning/middle/end markers; correct native functionCall |
| Function response follow-up | Same retained chat; exact final marker; HTTP 200; 18.02 s |
| Follow-up payload | 1,247 versus 78,955 full-context characters; 98.42% fewer characters; one Web message |

[Final metadata](mcp/native-context-delivery-live.json). These are individual live
measurements, not a general latency or provider-quota guarantee.

The [earlier passing baseline](mcp/native-context-delivery-baseline-live.json)
needed 5 Web messages for the same full context. The final version needs **4**.
A combined final-fragment/commit variant failed live acceptance and was not kept:
[rejected candidate](mcp/native-context-delivery-combined-commit-rejected.json).

After building and starting the native proxy:

```powershell
node tools/probes/native-context-delivery-smoke.mjs
node tools/probes/native-context-delivery-smoke.mjs --live
```

Without `--live`, only health is read. With it, synthetic context is sent to
Google. Actual IDE UI/executor review was **not retested**. Earlier terminal
failures are not repaired or replayed; create a fresh IDE request to use the fix.
