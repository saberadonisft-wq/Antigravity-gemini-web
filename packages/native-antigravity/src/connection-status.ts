import fs from "node:fs";
import path from "node:path";
import type { AccountRecord, NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";
import { assertNoLinks } from "./installation.js";

/** Read-only observation. Never starts a worker or creates/replaces pairing credentials. */
export async function observeConnections(accounts: readonly AccountRecord[]): Promise<NativeManagementSnapshot["connections"]> {
  return Promise.all(accounts.map(async account => {
    const base = { accountId: account.accountId, observedAt: new Date().toISOString() };
    if (account.browserTransport !== "extension") return { ...base, state: "legacy" as const };
    const file = path.join(account.profilePath, "extension-connector.json");
    try {
      assertNoLinks(file);
      if (!fs.existsSync(file)) return { ...base, state: "not_started" as const };
      if (fs.statSync(file).size > 2048) throw Error("Invalid pairing metadata");
      const credentials = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(credentials.token)) throw Error("Invalid pairing metadata");
      const response = await fetch(`http://127.0.0.1:${account.debugPort}/connector/status`, {
        headers: { authorization: "Bearer " + credentials.token }, signal: AbortSignal.timeout(1200), redirect: "error",
      });
      if (!response.ok) throw Error("Connector unavailable");
      // Status has a fixed shape and contains no identity or conversation data.
      const reader = response.body?.getReader();
      if (!reader) throw Error("No status");
      let bytes = "";
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += Buffer.from(chunk.value).toString("utf8"); if (bytes.length > 1024) throw Error("Status too large"); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const status = JSON.parse(bytes);
      if (typeof status.connected !== "boolean" || !Number.isInteger(status.geminiTabs) || status.geminiTabs < 0 || status.geminiTabs > 256) throw Error("Invalid status");
      return { ...base, state: status.connected ? "connected" as const : "disconnected" as const, geminiTabs: status.geminiTabs };
    } catch { return { ...base, state: "disconnected" as const }; }
  }));
}
