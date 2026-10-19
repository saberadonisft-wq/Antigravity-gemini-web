# Native response completion — 16/10/2026

## Cause and change

The browser broker retained a `completed` response containing only 43 characters
of the JSON block, ending inside the nonce shown in the reported screenshot.
Another recent result contained only 14 characters. Gemini continued rendering
after the broker had already settled. The native parser correctly rejected the
incomplete JSON with `INVALID_MODEL_ENVELOPE`.

Browser completion now requires visible feedback controls belonging to the
newest answer, no visible Stop control, and unchanged text/code for 600 ms.
Code Copy buttons, feedback on older answers, and hidden controls do not count.
English/Vietnamese Stop labels and locale-independent feedback icons are
recognized. Missing completion evidence times out instead of producing a
successful partial result. Nonce, inventory, schema and Unicode validation are
unchanged.

Send acknowledgement is bounded at 15 seconds instead of 5, without clicking
again. An initial real-browser follow-up failed at the old five-second boundary;
the final run below completed both turns.

Failed conversations previously consumed all five retained slots and blocked new
tasks with `BUSY`. Their durable replay fences now remain separately from the
five live slots. The ledger stays bounded at 2048 records and fails closed when
full. Unknown tasks remain blocked across restart; their fences are never evicted
to make room for a new conversation.

## Validation

- Full workspace build and typecheck: PASS.
- Browser package: 31/31 tests PASS, including a real CDP fixture that keeps a
  stable partial JSON pending without Stop, ignores old/hidden/Copy controls,
  detects a visible Vietnamese Stop after a hidden match, and returns the full
  code block only after the current answer completes.
- Native package: 49/49 tests PASS, including persisted quarantine beyond live
  slot capacity, restart, prevention of replay, and active-slot limits.
- MCP package: 32/32 tests PASS.
- The existing preserved-tab fixture now explicitly closes its test-owned
  browser before removing its temporary profile; production preservation stays
  unchanged.

Native runtime **20**, browser runtime fingerprint **11** were loaded on this
host. The previously running browser helper was idle before replacement. The
IDE and signed-in Chrome were retained.

## Real browser evidence and boundary

`node tools/probes/native-response-completion-smoke.mjs --live` passed:

1. Synthetic loopback request with a `view_file` declaration → real Gemini Web →
   complete, nonce/schema-validated native functionCall: HTTP 200, about 20 s.
2. Synthetic functionResponse → same retained Gemini conversation → exact final
   marker through native SSE: HTTP 200, about 8.3 s, 2 frames.

Metadata: [native-response-completion-live.json](mcp/native-response-completion-live.json).
The probe sends only synthetic content and does not read files or execute native
IDE tools. The actual IDE review request and IDE executor were **not retested**.
Earlier terminal failures are not replayed or retroactively repaired; start a new
IDE chat for a fresh request. Without `--live`, the probe only reads health.
