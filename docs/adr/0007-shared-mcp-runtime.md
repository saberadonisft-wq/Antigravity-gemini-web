# ADR 0007 — Shared runtime behind stdio MCP clients

Accepted 15/10/2026. Several native IDE clients can initialize the same server; a single stdio process owning profile/state locks made later clients fail with ownership/EOF.

Each frontend now connects to one owner per browser profile or host state. The owner authenticates a bounded private loopback handshake and configuration fingerprint before official SDK MCP framing. One kernel lock owns side effects and receipts. Closing one frontend preserves others; the last frontend triggers bounded cleanup.

Host tasks remain bound to their original MCP connection; other connections cannot claim/report/abort that task. Browser request IDs remain shared/idempotent. A reconnect does not replay RPC frames after delivery.

Native prompts require browser fingerprint v2 and a 2 MiB frame cap. Client policy still distinguishes native IDE from agy/VS Code. This is local process coordination, not a public authentication boundary.
