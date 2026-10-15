import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../renderer/App.js";
import { MockLauncherClient, type MockScenarioId } from "../renderer/client/mock-client.js";
import { type RuntimeEvent, type RuntimeSnapshot, type ActivityEntry, type ActivityQuery, type ControlCommand, type OperationRecord, type UiError, isTerminalTurnState } from "@antigravity-gemini-web/contracts";

class FixtureClient extends MockLauncherClient {
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private sequence = 0;
  private revision = 1;
  private instance = crypto.randomUUID();
  private sessions?: RuntimeSnapshot["sessions"];
  private jobs = new Map<string, OperationRecord>();
  private cancellations = new Map<string, { sessionId: string; turnId: string; previous: string }>();
  public failures = { activity: false, settings: false, export: false };
  public activityQueries: string[] = [];
  public activities: ActivityEntry[] = [];
  override async getSnapshot() {
    const snapshot = await super.getSnapshot();
    return { ...snapshot, runtimeInstanceId: this.instance, revision: this.revision, lastEventSequence: this.sequence, sessions: this.sessions ?? snapshot.sessions };
  }
  private async publish(type: RuntimeEvent["type"], payload: any) {
    const sequence = ++this.sequence;
    const event = { schemaVersion: "0.1" as const, runtimeInstanceId: this.instance, sequence, id: crypto.randomUUID(), occurredAt: new Date().toISOString(), type, payload } as RuntimeEvent;
    for (const listener of this.listeners) listener(event);
  }
  private async changed() { this.revision++; const snapshot = await this.getSnapshot(); snapshot.lastEventSequence = this.sequence + 1; await this.publish("snapshot.updated", { snapshot }); }
  override setScenario(scenario: MockScenarioId) {
    this.sessions = undefined; this.currentScenario = scenario;
    void this.changed();
  }
  override subscribe(callback: (event: RuntimeEvent) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  override async execute(command: ControlCommand) {
    if (command.type === "settings.update" && this.failures.settings) return { accepted: false as const, requestId: command.requestId, error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic settings failure.", retryable: false } satisfies UiError };
    if (command.type === "activity.export" && this.failures.export) return { accepted: false as const, requestId: command.requestId, error: { code: "CANCELLED", message: "Synthetic save dialog cancellation.", retryable: false } satisfies UiError };
    if (command.type === "turn.cancel") {
      const snapshot = await this.getSnapshot();
      const session = snapshot.sessions.find(s => s.id === command.payload.sessionId);
      const turn = session?.activeTurn;
      if (!turn || turn.id !== command.payload.turnId || !turn.canCancel || isTerminalTurnState(turn.state)) return { accepted: false as const, requestId: command.requestId, error: { code: "TURN_TERMINAL", message: "Synthetic turn cannot be cancelled.", retryable: false } satisfies UiError };
      const id = crypto.randomUUID();
      this.cancellations.set(id, { sessionId: session!.id, turnId: turn.id, previous: turn.state });
      this.jobs.set(id, { id, requestId: command.requestId, type: command.type, state: "running", updatedAt: new Date().toISOString() });
      turn.state = "cancel_requested"; turn.canCancel = false; this.sessions = snapshot.sessions;
      await this.changed();
      return { accepted: true as const, requestId: command.requestId, operationId: id };
    }
    const ack = await super.execute(command); await this.changed(); return ack;
  }
  override async getOperation(id: string) { return structuredClone(this.jobs.get(id) ?? await super.getOperation(id)); }
  public async finishCancel(confirmed: boolean) {
    const snapshot = await this.getSnapshot();
    for (const [id, binding] of this.cancellations) {
      const job = this.jobs.get(id)!;
      if (job.state !== "running") continue;
      const turn = snapshot.sessions.find(s => s.id === binding.sessionId)?.activeTurn;
      if (!turn || turn.id !== binding.turnId || turn.state !== "cancel_requested") continue;
      job.state = confirmed ? "succeeded" : "failed";
      if (!confirmed) job.error = { code: "SERVICE_UNAVAILABLE", message: "Synthetic host refused cancellation.", retryable: false };
      turn.state = confirmed ? "cancel_confirmed" : binding.previous as typeof turn.state;
      turn.canCancel = !confirmed;
      if (confirmed) turn.completedAt = new Date().toISOString();
      this.sessions = snapshot.sessions;
      await this.publish("operation.updated", { operation: structuredClone(job) });
    }
    await this.changed();
  }
  public async recover() { this.instance = crypto.randomUUID(); this.sequence = 0; this.currentScenario = "connection_ready_no_sessions"; this.sessions = undefined; }
  public async longWorkspace() { const snapshot = await this.getSnapshot(); this.sessions = snapshot.sessions; if (this.sessions[0]) this.sessions[0].workspaceLabel = "OWNED_FIXTURE_" + "workspace ".repeat(100); await this.changed(); }
  override async getActivity(query: ActivityQuery) {
    const rows = this.activities.length ? this.activities : (await super.getActivity(query)).items;
    const selected = rows.filter(row => (!query.severity || row.severity === query.severity) && (!query.sessionId || row.sessionId === query.sessionId));
    this.activityQueries.push(query.sessionId ?? "");
    await new Promise(resolve => setTimeout(resolve, query.sessionId === "slow" ? 200 : 10));
    if (this.failures.activity) throw { code: "SERVICE_UNAVAILABLE", message: "Synthetic activity failure.", retryable: false } satisfies UiError;
    const offset = Number(query.cursor ?? 0), size = query.limit ?? 50;
    return { items: structuredClone(selected.slice(offset, offset + size)), nextCursor: offset + size < selected.length ? String(offset + size) : undefined };
  }
}
const client = new FixtureClient();
Object.assign(globalThis, { __launcherFixture: client });
createRoot(document.getElementById("root")!).render(<App clientOverride={client} />);
