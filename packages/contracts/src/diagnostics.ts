import { UiErrorCodeSchema, type UiError } from "./errors.js";

const extraCodes = new Set(["UNAUTHORIZED_FRAME", "UNAUTHORIZED_ORIGIN", "UNAUTHORIZED_SENDER", "UNKNOWN_CHANNEL", "INVALID_ARGUMENT", "PRELOAD_UNAVAILABLE", "NOT_FOUND"]);
export function safeUiError(error: unknown): UiError {
  const code = error instanceof Error && error.name === "ZodError" ? "CONTRACT_MISMATCH" : error && typeof error === "object" && "code" in error ? String(error.code) : "SERVICE_UNAVAILABLE";
  const safeCode = UiErrorCodeSchema.safeParse(code).success || extraCodes.has(code) ? code : "SERVICE_UNAVAILABLE";
  return { code: safeCode, message: "Không thể hoàn tất thao tác (" + safeCode + ").", retryable: !["OUTCOME_UNKNOWN", "STALE_AUTHORITY", "CONFIG_CONFLICT", "CANCELLED"].includes(safeCode) };
}

/** Used on every outgoing IPC surface and disk export, including nested errors. */
export function sanitizeDiagnostics<T>(value: T): T {
  function walk(item: unknown, key = ""): unknown {
    if (/^(?:prompt|rawPrompt|cookie|password|token|secret|requestNonce|authorization|apiKey|userDataDir|profilePath)$/i.test(key)) return "[REDACTED]";
    if (typeof item === "string") {
      if (/cookie|password|authorization|api[_ -]?key|csrf|requestNonce|raw[_ ]?prompt|\bprompt\s*[:=]|\b(?:access[_ -]?|refresh[_ -]?)?token["'\s]*[:=]|\bsecret\b/i.test(item)) return "[REDACTED]";
      if (key === "displayLabel" && /@/.test(item)) return "Google account";
      return item;
    }
    if (Array.isArray(item)) return item.map(part => walk(part));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, part]) => [name, walk(part, name)]));
    return item;
  }
  return walk(value) as T;
}
