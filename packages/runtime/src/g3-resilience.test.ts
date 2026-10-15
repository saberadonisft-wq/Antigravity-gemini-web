import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ContextManager,
  RecoveryJournal,
  SessionCoordinator,
} from "./index.js";
import {
  type StructuredContext,
  type JournalEntry,
  type UiError,
} from "@antigravity-gemini-web/contracts";

async function safeRemoveTempDir(dir: string, maxWaitMs = 5000): Promise<void> {
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("g3-journal-test-"));
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "ENOTEMPTY") {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test("G3-A Context Manager: Workspace isolation and cross-workspace mixing prohibition", () => {
  const manager = new ContextManager();
  const context: StructuredContext = {
    workspaceId: "d:\\workspace-alpha",
    sessionId: "sess-1",
    instructions: "Follow coding standards.",
    history: [
      { role: "user", content: "Implement feature X." },
    ],
    toolResults: [],
  };

  // Valid when expected workspace matches
  assert.doesNotThrow(() => {
    manager.validateWorkspace(context, "D:/workspace-alpha");
  });

  // Rejects when expected workspace differs (cross-workspace leak prevention)
  assert.throws(
    () => {
      manager.validateWorkspace(context, "D:/workspace-beta");
    },
    (err: UiError) => {
      return err.code === "WORKSPACE_MISMATCH";
    }
  );
});

test("G3-A Context Manager: Preflight budget, labeled estimates, and CONTEXT_TOO_LARGE rejection", () => {
  const manager = new ContextManager({ localSafetyCapTokens: 50, maxByteSize: 1000 });

  const smallContext: StructuredContext = {
    workspaceId: "d:\\project",
    sessionId: "sess-1",
    instructions: "Be concise.",
    history: [{ role: "user", content: "Short message" }],
    toolResults: [],
  };

  const metrics = manager.assertWithinBudget(smallContext, "d:\\project");
  assert.equal(metrics.isEstimate, true, "Estimates must be explicitly labeled isEstimate: true");
  assert.equal(metrics.withinLimit, true);
  assert.ok(metrics.estimatedTokens < 50);

  // Large context exceeding safety cap
  const largeContext: StructuredContext = {
    workspaceId: "d:\\project",
    sessionId: "sess-1",
    instructions: "A".repeat(300), // ~75 tokens > cap 50
    history: [],
    toolResults: [],
  };

  assert.throws(
    () => {
      manager.assertWithinBudget(largeContext, "d:\\project");
    },
    (err: UiError) => {
      return err.code === "CONTEXT_TOO_LARGE" && err.message.includes("exceeds local safety cap");
    }
  );
});

test("G3-A Context Manager: Refusal of silent truncation / unverified compaction", () => {
  const manager = new ContextManager();
  const context: StructuredContext = {
    workspaceId: "d:\\project",
    sessionId: "sess-1",
    instructions: "System prompt",
    history: [
      { role: "user", content: "Step 1" },
      { role: "assistant", content: "Step 1 done" },
    ],
    toolResults: [],
  };

  // Compaction must fail explicitly rather than silently dropping instructions or history
  assert.throws(
    () => {
      manager.compact(context);
    },
    (err: UiError) => {
      return err.code === "UNSUPPORTED_OPERATION" && err.message.includes("Silent dropping");
    }
  );
});

test("G3-A Context Manager: Model binding verification and REBIND_REQUIRED notification", () => {
  const manager = new ContextManager();
  const context: StructuredContext = {
    workspaceId: "d:\\project",
    sessionId: "sess-1",
    instructions: "",
    history: [],
    toolResults: [],
    modelMetadata: {
      modelId: "gemini-pro-vision",
      isEstimate: true,
    },
  };

  assert.throws(
    () => {
      manager.verifyModelBinding(context, "gemini-1.5-pro");
    },
    (err: UiError) => {
      return err.code === "REBIND_REQUIRED";
    }
  );
});

test("G3-A Recovery Journal: Atomic writes, payload sanitization, and corrupt line resilience", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-journal-test-"));
  const journalPath = path.join(tempDir, "recovery.journal.jsonl");

  t.after(async () => {
    await safeRemoveTempDir(tempDir);
  });

  const journal = new RecoveryJournal(journalPath);
  const secretPrompt = "MY_SUPER_SECRET_TOKEN_DO_NOT_STORE";
  const safeHash = RecoveryJournal.hashPayload(secretPrompt);

  const entry: JournalEntry = {
    version: 1,
    instanceId: "inst-old-1",
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    turnId: "turn-101",
    requestId: "req-101",
    phase: "submitting",
    payloadHash: safeHash,
    timestamp: new Date().toISOString(),
    receipt: {
      submittedAt: new Date().toISOString(),
      deadlineMs: 5000,
    },
  };

  await journal.record(entry);

  // Read raw file to verify privacy: secret prompt MUST NOT appear on disk
  const rawDiskContent = fs.readFileSync(journalPath, "utf8");
  assert.ok(!rawDiskContent.includes(secretPrompt), "Raw secret prompt must never be written to journal disk");
  assert.ok(rawDiskContent.includes(safeHash), "SHA-256 payload hash must be stored");

  // Inject a corrupt/truncated line into the journal
  fs.appendFileSync(journalPath, "{corrupt_incomplete_json_line\n");

  // Load and reconcile with a new instance ID (simulating crash recovery)
  const report = await journal.loadAndReconcile("inst-new-2");
  assert.equal(report.corruptLinesEncountered, 1, "Corrupt line must be detected and tolerated");
  assert.equal(report.totalRecovered, 1);
  assert.ok(report.unknownMutations.includes("turn-101"), "Abandoned in-flight submission must transition to outcome_unknown");

  // Verify that turn-101 is now marked outcome_unknown and never replayed
  const recoveredEntry = journal.get("turn-101");
  assert.equal(recoveredEntry?.phase, "outcome_unknown");
  assert.equal(recoveredEntry?.terminalOutcome?.status, "outcome_unknown");
});

test("G3-A Session Coordinator: Bounded queue backpressure and QUEUE_FULL rejection", () => {
  const coordinator = new SessionCoordinator({
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    maxQueueSize: 2,
  });

  coordinator.enqueue({
    turnId: "turn-1",
    requestId: "req-1",
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    prompt: "Prompt 1",
    payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Prompt 1" }),
    queuedAt: Date.now(),
  });

  coordinator.enqueue({
    turnId: "turn-2",
    requestId: "req-2",
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    prompt: "Prompt 2",
    payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Prompt 2" }),
    queuedAt: Date.now(),
  });

  assert.equal(coordinator.queueDepth, 2);

  // 3rd item exceeds capacity 2 -> must reject with QUEUE_FULL
  assert.throws(
    () => {
      coordinator.enqueue({
        turnId: "turn-3",
        requestId: "req-3",
        workspaceId: "d:\\repo",
        sessionId: "sess-1",
        prompt: "Prompt 3",
        payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Prompt 3" }),
        queuedAt: Date.now(),
      });
    },
    (err: UiError) => {
      return err.code === "QUEUE_FULL";
    }
  );
});

test("G3-A Session Coordinator: Cancel queued item before Send releases slot without execution", () => {
  const coordinator = new SessionCoordinator({
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    maxQueueSize: 5,
  });

  coordinator.enqueue({
    turnId: "turn-cancel-me",
    requestId: "req-c1",
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    prompt: "Queued prompt",
    payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Queued prompt" }),
    queuedAt: Date.now(),
  });

  assert.equal(coordinator.queueDepth, 1);

  const cancelled = coordinator.cancelQueued("turn-cancel-me");
  assert.equal(cancelled, true, "Queued turn must be successfully cancelled");
  assert.equal(coordinator.queueDepth, 0, "Queue must be empty after cancellation");

  // Next execution must find nothing to execute
  const next = coordinator.nextForExecution();
  assert.equal(next, null, "Cancelled queued turn must never be dequeued for execution");
});

test("G3-A Session Coordinator: Host tool authority and STALE_AUTHORITY rejection", () => {
  const coordinator = new SessionCoordinator({
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    hostToolInventory: new Set(["read_file", "apply_patch"]),
  });

  coordinator.enqueue({ workspaceId: "d:\\repo", sessionId: "sess-1", turnId: "tool-turn", requestId: "tool-request", prompt: "Read file", payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Read file" }), queuedAt: Date.now() });
  coordinator.nextForExecution();
  coordinator.transitionActiveTurn("tool-turn", "submitting", coordinator.currentEpoch);
  coordinator.transitionActiveTurn("tool-turn", "accepted", coordinator.currentEpoch);
  coordinator.transitionActiveTurn("tool-turn", "tool_pending", coordinator.currentEpoch);
  const authority = coordinator.getActiveAuthority()!;

  // Valid tool within current epoch
  assert.doesNotThrow(() => {
    coordinator.verifyHostToolAuthority("read_file", authority);
  });

  // Unauthorized tool rejected with TOOL_DENIED
  assert.throws(
    () => {
      coordinator.verifyHostToolAuthority("dangerous_remote_shell", authority);
    },
    (err: UiError) => {
      return err.code === "TOOL_DENIED";
    }
  );

  // Stale epoch rejected with STALE_AUTHORITY
  assert.throws(
    () => {
      coordinator.verifyHostToolAuthority("read_file", { ...authority, epoch: coordinator.currentEpoch - 1 });
    },
    (err: UiError) => {
      return err.code === "STALE_AUTHORITY";
    }
  );
});

test("G3-A Session Coordinator: Disconnection handling, epoch retirement, and outcome_unknown transition", () => {
  const coordinator = new SessionCoordinator({
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
  });

  coordinator.enqueue({
    turnId: "turn-disconnect",
    requestId: "req-disc",
    workspaceId: "d:\\repo",
    sessionId: "sess-1",
    prompt: "Long running prompt",
    payloadHash: SessionCoordinator.fingerprintPayload({ prompt: "Long running prompt" }),
    queuedAt: Date.now(),
  });

  const executing = coordinator.nextForExecution();
  assert.ok(executing);
  coordinator.transitionActiveTurn("turn-disconnect", "submitting", coordinator.currentEpoch);
  assert.equal(coordinator.isBusy, true);

  const initialEpoch = coordinator.currentEpoch;

  // Simulate unexpected browser / CDP disconnect
  coordinator.handleDisconnection("CDP connection reset by peer");

  // Epoch must be bumped (retiring older authority)
  assert.ok(coordinator.currentEpoch > initialEpoch, "Epoch must increment upon disconnection");

  // Coordinator must no longer be busy, and the turn must not be re-executed
  assert.equal(coordinator.isBusy, false);
  const next = coordinator.nextForExecution();
  assert.equal(next, null, "In-flight mutation must not be replayed or auto-resent");
});

