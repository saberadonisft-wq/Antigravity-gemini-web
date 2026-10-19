/** JSON.parse accepts lone UTF-16 surrogates; protobuf JSON strings do not. */
export function validUnicodePrefix(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return i;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return i;
  }
  return text.length;
}

export function hasValidUnicode(value: unknown): boolean {
  if (typeof value === "string") return validUnicodePrefix(value) === value.length;
  if (Array.isArray(value)) return value.every(hasValidUnicode);
  if (value && typeof value === "object") return Object.entries(value).every(([key, entry]) => hasValidUnicode(key) && hasValidUnicode(entry));
  return true;
}
