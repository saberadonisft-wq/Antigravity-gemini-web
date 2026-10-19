# P8 follow-up: Node memory candidate benchmark

Date: 19/10/2026. Native source 36, browser worker 23. Status: **PASS synthetic pool lifecycle; production memory gate OPEN**.

Three sequential runs used the same pool build and probe, Node v24.18.0 / V8 13.6.233.17-node.50, 500 warmup rounds and 10,000 further generate/release rounds. Each run sampled this Node process after explicit GC and macrotask gaps. There were two synthetic backend objects, zero real MCP workers, zero Chrome processes and zero Google prompt requests. NODE_OPTIONS was absent in the invoking environment.

| Node startup setting | RSS after warmup | RSS after 10,000 rounds | Live heap change | Elapsed | Explicit GC time |
|---|---:|---:|---:|---:|---:|
| Default semi-space | 95.57 MiB | 201.86 MiB | +164.00 KiB | 37.244 s | 80 ms |
| `--max-semi-space-size=8` | 80.11 MiB | 88.97 MiB | +178.35 KiB | 31.801 s | 101 ms |
| `--max-semi-space-size=16` | 95.29 MiB | 104.55 MiB | +178.35 KiB | 43.629 s | 65 ms |

All three runs returned ownership and pending cleanup counts to zero. The default run's reported V8 new_space capacity increased from 32 to 128 MiB while its final used space was 632 bytes. Together with the small live-heap change, this supports investigating V8 capacity as a contributor to RSS growth. It does not establish the cause of every allocation or exclude leaks under other workloads.

There is one run per setting. These observations do not establish a throughput ranking, percentile latency, optimal production setting or a hard RAM limit. Node documents that semi-space sizing trades memory against throughput and should be benchmarked for the workload: [Node 24 CLI documentation](https://nodejs.org/download/release/v24.18.0/docs/api/cli.html#--max-semi-space-sizesize-in-mib).

## Artifacts and reproducibility

- [Default run](mcp/native-r36-pool-default-bench.json)
- [8 MiB semi-space run](mcp/native-r36-pool-semi8-bench.json)
- [16 MiB semi-space run](mcp/native-r36-pool-semi16-bench.json)
- Probe: `tools/probes/native-pool-lifecycle-spike.mjs`
- Probe SHA-256 in all three artifacts: `161f97758cf4cc1093728109539d9b2e98c13cfe7831db345e27faf347b17ffb`
- Compiled backend pool SHA-256 in all three artifacts: `4d856d4ea73f373a5414fd47257b732e7e1354f3ee9053a7ea7beea1f8fbc362`

Run with `node --expose-gc tools/probes/native-pool-lifecycle-spike.mjs --output=<new-artifact-path>`, adding the semi-space flag before the script path for the candidate runs. Preserve earlier artifacts when repeating. The artifact records startup flags, CPU usage, heap-space samples and explicit GC time; explicit GC time does not include every automatic collection.

## Next gate

No production startup flag or default was changed. Before applying a candidate, measure actual MCP shared-owner processes with large contexts, multiple workers, repeated trials and latency/CPU/RSS observations. Any option must reach the shared-service owner, rather than only its thin stdio frontend, and must be verified on the process that owns the work. Chrome memory requires separate measurement.

The main account browser was not navigated, restarted or upgraded. The 3.8-to-primary-model Web acceptance still awaits the user's Google verification. P6 live adapters and chooser selection, P7, and P8 soak/recovery/rollback gates remain open. This benchmark does not change their completion status. No commit, push or deployment was performed.
