/** Stable JSON object keys; array order and every value remain significant. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
  if (serialized === undefined) throw new TypeError("Payload must be JSON serializable.");
  return serialized;
}
