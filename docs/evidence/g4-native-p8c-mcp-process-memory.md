# P8: actual MCP process memory benchmark

Date: 19/10/2026. Production code baseline: commit `4e28d7a`, Native 36 / browser worker 23. Status: **PASS owned MCP process fixture; full P8 gate OPEN**.

## Workload and process ownership

Each sequential trial starts two actual Node shared-owner processes using production `startSharedRuntime`, `GeminiMcpService`, MCP servers and SQLite receipt stores. Four actual stdio frontend processes connect through production `runSharedStdio`, two per owner. The owners are started explicitly by the fixture with validated startup arguments; automatic production bootstrap/flag propagation is not exercised.

The browser adapter is synthetic. Each owner handles eight warmup and 210 further synthetic contexts. A context contains 260,000 characters split into ten independent 26,000-character MCP submissions, with unique roughly 24,000-character responses. This loads serialization, caches and receipts; it does **not** exercise native ACK/COMMIT, snapshot uploads, Google, model switching or the IDE executor.

Each owner completed **2,180 submissions**. Retrying its most recent request from the other frontend returns the same result without a new synthetic submission. The other owner cannot find that request's receipt. These assertions do not test replay of every earlier evicted result or replace the dedicated durable-replay tests.

## Observations

Owner RSS/heap are sampled after explicit GC and a macrotask gap. Windows `Get-Process` additionally records working set, private bytes and handle counts for all six owned PIDs. The stdio frontends receive no candidate memory flag.

| Owner startup setting | Final owner RSS A / B | Final owner live heap A / B | Per-fragment p50 / p95 | Elapsed including startup/sampling |
|---|---:|---:|---:|---:|
| Default semi-space | 199.39 / 189.84 MiB | 20.05 / 20.04 MiB | 4.47 / 6.18 ms | 12.148 s |
| `--max-semi-space-size=8` | 99.57 / 99.73 MiB | 20.04 / 20.04 MiB | 4.36 / 6.35 ms | 11.969 s |
| `--max-semi-space-size=16` | 110.38 / 112.95 MiB | 20.04 / 20.04 MiB | 4.33 / 6.12 ms | 11.879 s |

Each latency sample measures one MCP submit-and-result operation during the soak portion; there are 4,200 samples per trial. It is not Web response latency. These are one-trial observations per setting, not a throughput ranking or a latency guarantee. The 8 MiB candidate reduced the sum of owner RSS by about 49% in this workload. It does not establish a 49% reduction for the app, frontends or Chrome. Summed process RSS/working sets can double-count shared pages and are not unique physical RAM usage.

The probe observes the SDK transport's physical child-close events as well as awaiting `client.close`, because SDK close may return just after issuing its final termination signal. All three trials confirmed **four frontend exits and two successful owner exits** before removing their exact owned temporary root. No production profile was opened, navigated, restarted or removed.

## Reproduction and evidence

Build the workspace first, then run sequentially with a different output path for each setting:

```powershell
node tools/probes/native-mcp-memory-spike.mjs --rounds=210 --warmup=8 --output=.tmp/mcp-memory-default.json
node tools/probes/native-mcp-memory-spike.mjs --rounds=210 --warmup=8 --semi-space=8 --output=.tmp/mcp-memory-semi8.json
node tools/probes/native-mcp-memory-spike.mjs --rounds=210 --warmup=8 --semi-space=16 --output=.tmp/mcp-memory-semi16.json
```

- [Default artifact](mcp/native-r36-mcp-memory-default.json)
- [8 MiB artifact](mcp/native-r36-mcp-memory-semi8.json)
- [16 MiB artifact](mcp/native-r36-mcp-memory-semi16.json)
- Probe: `tools/probes/native-mcp-memory-spike.mjs`; owner fixture: `tools/probes/fixtures/native-mcp-memory-owner.mjs`.

Artifacts contain Node/V8 versions, actual owner startup arguments, process diagnostics and hashes of the production modules and both probe files. The source hashes match across trials and the current files. A short one-context fixture run and syntax checks also passed. The full **406-test workspace validation belongs to baseline commit `4e28d7a`**; production modules were unchanged by this follow-up, and that count was not rerun or added to the probe count.

The benchmark checks a three-minute work budget before each tool call, validates finite workload/settings, uses synthetic data only, and preserves the owned temp root on teardown failure. Individual MCP calls also have the SDK timeout; teardown has separate bounded waits. It neither exports runtime tokens nor includes project data.

## Next gate

The 8 MiB setting is a candidate for an explicit opt-in policy. Before implementing it, propagate a validated setting to the actual production shared-service owner, include it in the worker fingerprint, verify the applied startup setting before Send and reject incompatible existing workers without restarting them. Benchmark actual Chrome/DOM workloads and repeat trials before choosing a default. No production memory setting changed here.

The broader P8 soak/crash/orphan/Windows restart/restore/rollback gates remain open, as do the real Web/account/IDE and P6/P7 gates. See the [full plan](../archive/plans/NATIVE_UPGRADE_PLAN.md) and [earlier standalone Node experiment](g4-native-p8b-node-memory-benchmark.md).
