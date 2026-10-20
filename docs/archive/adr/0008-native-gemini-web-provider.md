# ADR 0008 — Native Cloud Code compatibility route to Gemini Web

Accepted 15/10/2026 after native picker, chat and read-file roundtrip observations.

G2 standalone probes never reached inference. The installed IDE is 2.5.5, built on VS Code 1.107.0. Its core/launcher use jetski.cloudCodeUrl. A dedicated user-data profile routes it to loopback 9236.

The proxy preserves authenticated bootstrap and known metadata endpoints on Google's production/daily Cloud Code services. It injects one collision-checked, persisted native enum identity for Gemini Web (Local). Generation for another model is rejected; there is no API fallback.

Each generation compiles the full native text context/tool schemas into a nonce-bound request. Shared browser MCP owns mutation and durable receipts; native requests use fresh tabs and restore the original page. Structured output becomes a candidate or an exact schema-validated functionCall. Antigravity remains executor and permission authority.

Oversized/unsupported input fails explicitly. SSE carries completed browser output. Incremental tokens, model-family pinning and long-context compaction remain separate validation work. The catalog compatibility floor is not a measured Google context limit.

The reverse Google custom-app route is independent. This native provider uses native function calls without it. Vendor files, binary and main IDE settings remain untouched.
