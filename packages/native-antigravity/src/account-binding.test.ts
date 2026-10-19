import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NativeConversationState, type NativeContext } from "./conversation-state.js";
import { NativeRouteError, sha256 } from "./native-protocol.js";
import { applyContextPatch } from "./context-patch.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const makeContext = (contents: unknown[], tools: unknown[] = [], systemInstruction = "system rules"): NativeContext => ({
  contents,
  tools,
  systemInstruction,
});

test("P2 Gate: Same IDE chat across A -> B -> A switches (12 alternating switches)", () => {
  const states = new NativeConversationState();
  const taskKey = sha256("ide-shared-chat-multi-account");
  const accountA = "acc_alpha";
  const accountB = "acc_beta";

  let history: unknown[] = [];
  const keyA_set = new Set<string>();
  const keyB_set = new Set<string>();
  let lastRevA: string | undefined;
  let lastRevB: string | undefined;

  // Run 12 alternating turns:
  // Turn 1: A
  // Turn 2: B (switch 1)
  // Turn 3: A (switch 2)
  // Turn 4: B (switch 3)
  // Turn 5: A (switch 4)
  // Turn 6: B (switch 5)
  // Turn 7: A (switch 6)
  // Turn 8: B (switch 7)
  // Turn 9: A (switch 8)
  // Turn 10: B (switch 9)
  // Turn 11: A (switch 10)
  // Turn 12: B (switch 11) - total 11 switches (> 10 switches required by Gate)
  for (let turn = 1; turn <= 12; turn++) {
    const isAccountA = turn % 2 === 1;
    const currentAccount = isAccountA ? accountA : accountB;
    history.push({ role: "user", parts: [{ text: `User message turn ${turn}` }] });
    history.push({ role: "model", parts: [{ text: `Model answer turn ${turn}` }] });

    const ctx = makeContext([...history]);
    const plan = states.prepare(taskKey, ctx, false, undefined, currentAccount);
    assert.ok(plan, `Plan must exist for turn ${turn}`);

    if (isAccountA) {
      if (lastRevA === undefined) {
        // First turn on A: full mode, no base
        assert.equal(plan.mode, "full");
        assert.equal(plan.baseRevision, undefined);
      } else {
        // Subsequent turns on A: must use A's own previous baseRevision, never B's
        assert.equal(plan.baseRevision, lastRevA);
        assert.equal(plan.mode, "append");
        assert.ok(plan.appendFrom > 0);
      }
      keyA_set.add(plan.key);
      lastRevA = plan.revision;
    } else {
      if (lastRevB === undefined) {
        // First turn on B: full mode, no base, must NOT use A's base
        assert.equal(plan.mode, "full");
        assert.equal(plan.baseRevision, undefined);
      } else {
        // Subsequent turns on B: must use B's own previous baseRevision, never A's
        assert.equal(plan.baseRevision, lastRevB);
        assert.equal(plan.mode, "append");
        assert.ok(plan.appendFrom > 0);
      }
      keyB_set.add(plan.key);
      lastRevB = plan.revision;
    }

    // Complete the turn with account-specific web URL
    const url = isAccountA ? `https://gemini.google.com/app/chat_a_${turn}` : `https://gemini.google.com/app/chat_b_${turn}`;
    states.complete(plan, url);
  }

  // Verify that Account A used exactly 1 persistent conversation key throughout
  assert.equal(keyA_set.size, 1, "Account A must retain a single conversation key");
  // Verify that Account B used exactly 1 persistent conversation key throughout
  assert.equal(keyB_set.size, 1, "Account B must retain a single conversation key");
  // Verify Account A's key is distinct from Account B's key
  assert.notEqual([...keyA_set][0], [...keyB_set][0], "Account A and B keys must be distinct");
});

test("P2: Tool inventory and system instruction modifications during account switch use patch mode against own base", () => {
  const states = new NativeConversationState();
  const taskKey = sha256("ide-chat-tool-update");
  const accA = "acc_A";
  const accB = "acc_B";

  const largeHistory = Array.from({ length: 10 }, (_, i) => ({
    role: "user",
    parts: [{ text: `Historical message ${i} with substantial detailed contents to exercise context patching efficiently` }],
  }));

  // Turn 1 on Account A with tool [tool1]
  const ctxA1 = makeContext([...largeHistory], [{ name: "tool1" }], "rules v1");
  const planA1 = states.prepare(taskKey, ctxA1, false, undefined, accA)!;
  assert.equal(planA1.mode, "full");
  states.complete(planA1);

  // Turn 2 on Account B: fresh bootstrap, tools [tool1]
  const ctxB1 = makeContext([...largeHistory, { role: "user", parts: [{ text: "msg B1" }] }], [{ name: "tool1" }], "rules v1");
  const planB1 = states.prepare(taskKey, ctxB1, false, undefined, accB)!;
  assert.equal(planB1.mode, "full");
  assert.equal(planB1.baseRevision, undefined);
  states.complete(planB1);

  // Turn 3: Switch back to Account A, but IDE updated tools to [tool1, tool2] and rules to "rules v2"
  const ctxA2 = makeContext([...largeHistory, { role: "user", parts: [{ text: "msg A2" }] }], [{ name: "tool1" }, { name: "tool2" }], "rules v2");
  const planA2 = states.prepare(taskKey, ctxA2, false, undefined, accA)!;

  // Mode must be patch because static parts (tools and system rules) changed
  assert.equal(planA2.mode, "patch");
  // Must use Account A's baseRevision from planA1, NOT Account B's
  assert.equal(planA2.baseRevision, planA1.revision);
  assert.ok(planA2.patches && planA2.patches.length > 0);

  // Verifying reconstructed context matches ctxA2
  const reconstructed = applyContextPatch(planA1.context, planA2.patches);
  assert.deepEqual(reconstructed, ctxA2);
  states.complete(planA2);

  // Turn 4: Switch back to Account B, IDE now has [tool1, tool2, tool3]
  const ctxB2 = makeContext([...largeHistory, { role: "user", parts: [{ text: "msg B1" }] }, { role: "user", parts: [{ text: "msg B2" }] }], [{ name: "tool1" }, { name: "tool2" }, { name: "tool3" }], "rules v2");
  const planB2 = states.prepare(taskKey, ctxB2, false, undefined, accB)!;

  assert.equal(planB2.mode, "patch");
  // Must use Account B's baseRevision from planB1, NOT Account A's
  assert.equal(planB2.baseRevision, planB1.revision);
  const reconstructedB = applyContextPatch(planB1.context, planB2.patches!);
  assert.deepEqual(reconstructedB, ctxB2);
  states.complete(planB2);
});

test("P2: Delayed callback / stale completion cannot cross accounts or corrupt active reservations", () => {
  const states = new NativeConversationState();
  const taskKey = sha256("ide-chat-stale-callback");
  const accA = "acc_A";
  const accB = "acc_B";

  // Account A starts turn 1
  const planA1 = states.prepare(taskKey, makeContext(["a1"]), false, undefined, accA)!;

  // While Turn A1 is pending, Account A is busy
  assert.throws(
    () => states.prepare(taskKey, makeContext(["a1", "a2"]), false, undefined, accA),
    { code: "BUSY" }
  );

  // Switching account cannot bypass sequencing in the same IDE conversation.
  assert.throws(() => states.prepare(taskKey, makeContext(["a1", "b1"]), false, undefined, accB), { code: "BUSY" });
  const planB1 = states.prepare(sha256("other-ide-chat"), makeContext(["b1"]), false, undefined, accB)!;
  assert.notEqual(planB1.key, planA1.key);

  // Delayed callback arrives from Account A trying to tamper with plan B's reservation:
  const spoofedPlan = { ...planA1, reservation: planB1.reservation };
  assert.throws(
    () => states.complete(spoofedPlan),
    { code: "STALE_AUTHORITY" }
  );

  // Valid delayed callback from Account A finishes Account A:
  states.complete(planA1);

  // Account B is still pending and finishes cleanly:
  states.complete(planB1);
});

test("P2: Outcome unknown fences the IDE conversation across accounts but allows an independent chat", () => {
  const states = new NativeConversationState();
  const taskKey = sha256("ide-chat-outcome-fence");
  const accA = "acc_A";
  const accB = "acc_B";

  // Account A turn 1
  const planA = states.prepare(taskKey, makeContext(["a1"]), false, undefined, accA)!;
  // Account A suffers an unconfirmed disconnect
  states.markOutcomeUnknown(planA);

  // Subsequent turn on Account A is fenced
  assert.throws(
    () => states.prepare(taskKey, makeContext(["a1", "a2"]), false, undefined, accA),
    (err: unknown) => err instanceof NativeRouteError && err.code === "OUTCOME_UNKNOWN"
  );

  assert.throws(() => states.prepare(taskKey, makeContext(["a1", "a2"]), false, undefined, accB), { code: "OUTCOME_UNKNOWN" });
  const planB = states.prepare(sha256("independent-chat"), makeContext(["b1"]), false, undefined, accB)!;
  assert.equal(planB.mode, "full");
  states.complete(planB);

  // Explicit resume with exact URL on Account A clears Account A's fence
  const resumeUrl = "https://gemini.google.com/app/exact_chat_a";
  const planAResumed = states.prepare(taskKey, makeContext(["a1", "a2", "a3"]), true, resumeUrl, accA)!;
  assert.equal(planAResumed.resumeUrl, resumeUrl);
  states.complete(planAResumed);
  const afterRecovery = states.prepare(taskKey, makeContext(["a1", "a2", "a3", "b4"]), false, undefined, accB)!;
  assert.equal(afterRecovery.mode, "full");
});

test("P2: Persisted metadata isolates account resume URLs across restarts", () => {
  const tmp = createTempDir("account-binding-persist-");
  try {
    const cacheFile = path.join(tmp, "native-cache.json");
    const states1 = new NativeConversationState(5, cacheFile);
    const taskKey = sha256("ide-chat-restart");
    const accA = "acc_A";
    const accB = "acc_B";

    const urlA = "https://gemini.google.com/app/saved_chat_a";
    const urlB = "https://gemini.google.com/app/saved_chat_b";

    // Setup A and complete
    const planA = states1.prepare(taskKey, makeContext(["m1"]), false, undefined, accA)!;
    states1.complete(planA, urlA);

    // Setup B and complete
    const planB = states1.prepare(taskKey, makeContext(["m1", "m2"]), false, undefined, accB)!;
    states1.complete(planB, urlB);

    // Restart: simulate new process loading persisted cache
    const states2 = new NativeConversationState(5, cacheFile);

    // Account A resume retained
    const resumePlanA = states2.prepare(taskKey, makeContext(["m1", "m2", "m3"]), false, undefined, accA)!;
    assert.equal(resumePlanA.resumeUrl, urlA);
    states2.complete(resumePlanA, urlA);

    // Account B resume retained
    const resumePlanB = states2.prepare(taskKey, makeContext(["m1", "m2", "m3", "m4"]), false, undefined, accB)!;
    assert.equal(resumePlanB.resumeUrl, urlB);

    assert.notEqual(resumePlanA.key, resumePlanB.key);
    assert.notEqual(resumePlanA.resumeUrl, resumePlanB.resumeUrl);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
