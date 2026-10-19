# P8: opt-in Node startup memory policy

Date: 19/10/2026. Native source **37**, browser worker fingerprint **24**. Baseline commit `01fc501`. Status: **PASS local/process acceptance; broader P8 gates OPEN**.

## Implemented behavior

`AG_MCP_NODE_SEMI_SPACE_MB` accepts `8`, `16`, `off`, empty or absent. It is off by default and controls only a V8 semi-space startup flag. It is not a total Node/Chrome RAM limit, does not override unrelated Node configuration and never accepts arbitrary Node arguments.

The Native pool and backend capture the setting rather than following later environment changes. Native passes the validated flag to its stdio frontend and pins the corresponding environment value. Production shared-stdio bootstrap passes the flag to the actual owner. Browser fingerprint 24 includes the requested setting, including zero for off. An incompatible active worker rejects the new connection without being stopped, replaced or sent a prompt.

The owner validates startup before acquiring its scope or constructing the runtime. `gemini_status.nodeMemory` reports its PID, requested setting, explicit CLI value and consistent applied/not_requested/mismatch state. It does not expose raw argv, environment, profiles or source data. Native requires an applied matching shared-owner status when enabled, before browser readiness can open a browser and before Send. Off preserves compatibility with older status shapes at this check; normal worker fingerprint compatibility still applies.

Native health `backendResources.requestedNodeSemiSpaceMiB` reports only the requested setting. The live inspection probe now understands revision 37/worker 24 and derives the setting from health rather than the inspector terminal's environment.

## Fresh validation

Workspace build, typecheck and lint PASS. All **415 tests PASS**, zero failed, skipped or cancelled:

| Package | Passed |
|---|---:|
| contracts | 12 |
| gemini-browser | 47 |
| mcp-server | 52 |
| model-bridge | 4 |
| native-antigravity | 171 |
| runtime | 80 |
| launcher | 49 |

Nine new tests also ran independently before the full suite. They cover finite settings/argument rejection; contradictory or frontend diagnostics; last CLI value handling; missing flag rejected before runtime construction; actual production CLI bootstrap for 8/16/off; distinct frontend/owner PID; conflicting connection retaining the original owner; Native policy mismatch blocking all browser actions/Send; off compatibility; and the actual Native frontend/shared-owner chain retaining captured policy after environment changes.

For that last chain, a test-only entry validates the expected startup flag in both processes before importing the unchanged production CLI. Native connects through its public receipt-inspection API on an owned temporary profile. The production CLI tests call only `gemini_status`; no Chrome or Google prompt is opened. Browser generation in other regressions uses controlled local fixtures.

Logs: `.tmp/p8-r37-{build,typecheck,lint,all-tests,node-memory-tests}.log`. [Manifest and boundaries](mcp/native-r37-node-memory-offline.json). Reproduce the focused tests after build with:

```powershell
node --test --test-timeout=30000 packages/contracts/dist/node-memory.test.js packages/mcp-server/dist/node-memory.test.js packages/native-antigravity/dist/node-memory.test.js
```

## Runtime and remaining gates

Read-only main health failed twice on 19/10; the descriptor's PID was confirmed absent with `ESRCH`. This does not establish the state of the user's Chrome verification window. No browser was navigated, closed, restarted or upgraded, and no main proxy restart was attempted. The revision 29 observation in older evidence is historical.

The [source 36 process benchmark](g4-native-p8c-mcp-process-memory.md) remains the evidence for the candidate setting; it used synthetic browsers. This patch proves propagation/startup/config guards, not production RAM, Google latency or an optimal default. Actual Chrome/DOM measurements, repeated soak, crash/orphan recovery, baseline restore/rollback and Windows restart remain open, along with 3.8-to-primary Web acceptance, real A/B accounts, the complete IDE executor and P6/P7.

Operation and rollback: [Node memory guide](../NATIVE_NODE_MEMORY.md), [recovery runbook](../NATIVE_RECOVERY_RUNBOOK.md). No push, merge, public sharing or deployment was performed.
