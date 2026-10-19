import { canonical, object, NativeRouteError } from "./native-protocol.js";

type Path = Array<string | number>;
export type ContextPatch =
  | { op: "set"; path: Path; value: unknown }
  | { op: "remove"; path: Path }
  | { op: "splice"; path: Path; start: number; deleteCount: number; items: unknown[] }
  | { op: "text"; path: Path; oldText: string; newText: string };

export const wireValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const size = (value: unknown) => JSON.stringify(value).length;
const own = (value: object, key: string | number) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = () => new NativeRouteError("CONTEXT_SYNC_FAILED", "Context update could not be verified locally; nothing was sent.", 409);

/** Exact, ordered edits. No summaries, dropped fields or inferred equivalent history. */
export function contextPatch(before: unknown, after: unknown, path: Path = []): ContextPatch[] {
  if (canonical(before) === canonical(after)) return [];
  const replacement: ContextPatch[] = [{ op: "set", path, value: after }];
  let edits: ContextPatch[] = replacement;
  if (typeof before === "string" && typeof after === "string" && before.length) {
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
    while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    // Include anchors until the literal old fragment is unique. No character
    // offsets are delegated to the model (UTF-16/Unicode indexing differs).
    let start = Math.max(0, prefix - 24), end = Math.min(before.length, before.length - suffix + 24);
    while (start > 0 || end < before.length) {
      const fragment = before.slice(start, end);
      if (fragment && before.indexOf(fragment) === before.lastIndexOf(fragment)) break;
      start = Math.max(0, start - 64); end = Math.min(before.length, end + 64);
    }
    if (start && /[\uDC00-\uDFFF]/.test(before[start])) start--;
    if (end < before.length && /[\uD800-\uDBFF]/.test(before[end - 1])) end++;
    const oldText = before.slice(start, end), newText = after.slice(start, after.length - (before.length - end));
    edits = [{ op: "text", path, oldText, newText }];
  } else if (Array.isArray(before) && Array.isArray(after)) {
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(before.length, after.length) && canonical(before[prefix]) === canonical(after[prefix])) prefix++;
    while (suffix < Math.min(before.length, after.length) - prefix && canonical(before[before.length - 1 - suffix]) === canonical(after[after.length - 1 - suffix])) suffix++;
    const removed = before.length - prefix - suffix, inserted = after.length - prefix - suffix;
    edits = [{ op: "splice", path, start: prefix, deleteCount: removed, items: after.slice(prefix, after.length - suffix) }];
    if (removed === inserted) {
      const nested = after.slice(prefix, after.length - suffix).flatMap((value, index) => contextPatch(before[prefix + index], value, [...path, prefix + index]));
      if (size(nested) < size(edits)) edits = nested;
    }
  } else if (object(before) && object(after)) {
    edits = [];
    for (const key of Object.keys(before).sort()) if (!own(after, key)) edits.push({ op: "remove", path: [...path, key] });
    for (const key of Object.keys(after).sort()) {
      if (!own(before, key)) edits.push({ op: "set", path: [...path, key], value: after[key] });
      else edits.push(...contextPatch(before[key], after[key], [...path, key]));
    }
  }
  return size(edits) < size(replacement) ? edits : replacement;
}

/** Local proof of reconstruction, also used by the offline receiver fixture. */
export function applyContextPatch<T>(base: T, patches: ContextPatch[]): T {
  let root: unknown = wireValue(base);
  const get = (path: Path) => path.reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !own(value, key)) throw invalid();
    return (value as Record<string | number, unknown>)[key];
  }, root);
  const set = (path: Path, value: unknown) => {
    if (!path.length) { root = wireValue(value); return; }
    const parent = get(path.slice(0, -1)), key = path.at(-1)!;
    if (!parent || typeof parent !== "object") throw invalid();
    // defineProperty treats __proto__ as data, never as a prototype mutation.
    Object.defineProperty(parent, key, { value: wireValue(value), writable: true, enumerable: true, configurable: true });
  };
  for (const patch of patches) {
    if (patch.op === "set") set(patch.path, patch.value);
    else if (patch.op === "remove") {
      const parent = get(patch.path.slice(0, -1)), key = patch.path.at(-1);
      if (!parent || typeof parent !== "object" || key === undefined || !own(parent, key) || Array.isArray(parent)) throw invalid();
      delete (parent as Record<string | number, unknown>)[key];
    } else if (patch.op === "splice") {
      const target = get(patch.path);
      if (!Array.isArray(target) || !Number.isInteger(patch.start) || patch.start < 0 || patch.start > target.length || !Number.isInteger(patch.deleteCount) || patch.deleteCount < 0 || patch.start + patch.deleteCount > target.length) throw invalid();
      set(patch.path, target.slice(0, patch.start).concat(wireValue(patch.items), target.slice(patch.start + patch.deleteCount)));
    } else {
      const target = get(patch.path), first = typeof target === "string" ? target.indexOf(patch.oldText) : -1;
      if (typeof target !== "string" || !patch.oldText || first < 0 || first !== target.lastIndexOf(patch.oldText)) throw invalid();
      set(patch.path, target.slice(0, first) + patch.newText + target.slice(first + patch.oldText.length));
    }
  }
  return root as T;
}
