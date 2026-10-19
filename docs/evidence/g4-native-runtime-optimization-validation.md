# Native runtime optimization — revision 22

Checked 2026-10-16. Browser shared-runtime fingerprint: 13.

## Changes

- Native result cache: at most 32 idle terminal entries, lazy 10-minute TTL;
  pending requests and HTTP waiters remain protected. Evicted identities remain
  fenced in the process (up to 65,536 identities; fail closed at capacity).
- Browser MCP: the same result count/TTL policy, independent of the existing
  durable 2,048-request receipt ledger. Evicted results cannot cause another
  Send, including after restart. The ledger limit is intentional and remains.
- Browser adapter: retains at most 32 settled prompt/result records under
  normal sequential use; lightweight hashes fence retired turn IDs.
- Native no longer sleeps one second after each ACK or final answer. Chromium
  checks editable/composer state, aria-busy/inert state, generation state,
  control readiness and stable DOM observations at 100 ms intervals before
  input and before returning verified input for Send. Each readiness phase
  requires 200 ms stability and has a 5-second deadline. Cancellation is checked
  before editor mutation and Send; a clicked Send is never clicked again.
- Tool preparation uses an LRU cache keyed by SHA-256 of canonical complete
  declarations, bounded to 16 inventories / 4 Mi UTF-16 declaration characters.
  Each inventory owns an Ajv registry; original schemas still validate arguments.
  Wire declarations are cloned for each turn; nonce, function policy and
  allowlists remain per turn.
- Added concise descriptions for common native tools and repeated toolAction /
  toolSummary fields. Schema literal values in enum/const/default/examples are
  preserved during description compaction. No real-inventory 5–6 KB saving or
  fragment-count improvement is claimed.
- Explicit opt-in batches now allow 2–8 independent view_file/list_dir/grep_search
  calls in ANY/AUTO/VALIDATED modes. Schema, allowlist, duplicate, mutating-tool
  and NONE-mode rejection remain enforced. Default remains off.

## Local verification

- Workspace build and typecheck: PASS.
- Native: 56/56. Includes 140 completed HTTP requests plus an uncertain failure,
  evicted success/failure retries without resend, recent-result replay, cached
  schema mutation/policy isolation, changed schemas with equal $id, cache
  eviction while parsers remain live, and gated read-only batch modes.
- Browser: 35/35. Real CDP fixture includes terminal response with enabled Send
  but busy composer, sequential follow-up and cancellation during readiness.
  Also verifies 140 adapter turns with retired-ID replay prevention.
- Browser MCP: 33/33. Includes 140 completed requests, result eviction,
  conflicting-content rejection and durable no-replay after service restart.
- Runtime owned-browser CDP fixture: 1/1, crash/reconnect without replay.
- Total related tests: 125/125. This is not a full workspace test run.

Logs: `.tmp/native-optimization-{build,typecheck,native-test,browser-test,mcp-test,runtime-fixture}.log`.

## Live boundary

The first revision-22 attempt stopped at the sign-in checkpoint before sending.
After user sign-in, the selected Web model was Flash-Lite. A new synthetic
78,642-character native request delivered its first fragment and received the
correct ACK; Gemini returned a plain service/model failure on fragment two.
The bridge rejected it as CONTEXT_FRAGMENT_ACK_FAILED, did not send the commit,
and did not forward staging output as a tool call.

[Live attempt](mcp/native-optimization-live.json). A separate synthetic control
with an added 1,000 ms pause before each follow-up also failed acknowledgement,
this time on fragment three: [settling control](mcp/native-optimization-settle-control.json).
This does not establish a cause or show that DOM readiness is responsible for
the model's failure; it also does not prove successful long-context acceptance.
IDE UI/executor and live multi-tool
execution have not been accepted for revision 22. Prior revision-21 live results
are historical and do not prove this revision's acceptance.

The subsequent short synthetic tool loop **passed on real Gemini Web** with
revision 22: one native functionCall, its synthetic functionResponse, then the
exact final marker in the same retained conversation. Both HTTP requests
completed; the follow-up used a 1,142-character context patch. There was no
native post-result sleep: final silent intervals were approximately 651–652 ms,
including the browser's existing 600 ms response stability gate.
[Short live tool-loop evidence](mcp/native-optimization-short-live.json).
This proves the tested browser/protocol path, not an actual IDE file executor,
batch executor, long-context success or a general latency improvement.
