import test from "node:test";
import assert from "node:assert/strict";
import { applyContextPatch, contextPatch } from "./context-patch.js";

test("Context patches preserve Unicode, repeated text, arrays, deletion and JSON property names exactly", () => {
  const before = JSON.parse('{"__proto__":{"value":"old"},"constructor":"data","obsolete":true}');
  Object.assign(before, { padding: "unchanged ".repeat(1000), text: "😀before ".repeat(100) + "unique middle 😀" + "後🧪".repeat(100), history: [1, 1, 2, 3, 3] });
  const after = JSON.parse(JSON.stringify(before));
  after.__proto__.value = "new"; delete after.obsolete;
  after.text = after.text.replace("unique middle 😀", "unique middle 😃 changed");
  after.history = [1, 1, 8, 9, 3, 3];
  const patches = contextPatch(before, after);
  assert.ok(patches.some(p => p.op === "text"));
  assert.deepEqual(applyContextPatch(before, patches), after);
  assert.equal(Object.getPrototypeOf(applyContextPatch(before, patches)), Object.prototype);
  assert.equal(before.__proto__.value, "old"); assert.equal(before.obsolete, true);
  assert.ok(JSON.stringify(patches).length < JSON.stringify(after).length / 10);
});

test("Ambiguous text edits and invalid paths are rejected; large array insertion has no argument limit", () => {
  assert.throws(() => applyContextPatch({ text: "same same" }, [{ op: "text", path: ["text"], oldText: "same", newText: "x" }]), { code: "CONTEXT_SYNC_FAILED" });
  assert.throws(() => applyContextPatch({}, [{ op: "set", path: ["__proto__", "polluted"], value: true }]), { code: "CONTEXT_SYNC_FAILED" });
  assert.throws(() => applyContextPatch([], [{ op: "splice", path: [], start: 1, deleteCount: 0, items: [] }]), { code: "CONTEXT_SYNC_FAILED" });
  const large = Array.from({ length: 150000 }, () => 1);
  assert.deepEqual(applyContextPatch([0], [{ op: "splice", path: [], start: 1, deleteCount: 0, items: large }]), [0].concat(large));
});

test("Deterministic varied context edits reconstruct the complete authoritative value", () => {
  let seed = 1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const atoms = ["😀", "😃", "é", "漢字", "a", "", "same"];
  for (let i = 0; i < 200; i++) {
    const text = Array.from({ length: 100 }, () => atoms[random() % atoms.length]).join("");
    const before = { text, items: Array.from({ length: 8 }, () => random() % 4), stable: "x".repeat(2000) };
    const after = { ...before, text: text.slice(0, i % 50) + atoms[random() % atoms.length] + text.slice(50 + i % 40), items: before.items.slice(0, i % 8) };
    assert.deepEqual(applyContextPatch(before, contextPatch(before, after)), after);
  }
});
