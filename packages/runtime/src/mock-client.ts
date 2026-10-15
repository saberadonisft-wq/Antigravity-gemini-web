import type {
  LauncherClient,
  RuntimeSnapshot,
  ControlCommand,
  CommandAck,
  OperationRecord,
  SessionSummary,
  ActivityEntry,
  ActivityQuery,
  Page,
  RuntimeEvent,
} from "@antigravity-gemini-web/contracts";
import { FakeRuntimeEngine } from "./fake-runtime.js";
import { InProcessLauncherClient } from "./in-process-client.js";
import type { ScenarioName } from "./scenarios.js";

export class MockLauncherClient implements LauncherClient {
  public readonly demoBanner = "Demo · dữ liệu mô phỏng" as const;
  private engine: FakeRuntimeEngine;
  private client: InProcessLauncherClient;

  constructor(initialScenario: ScenarioName = "first_run") {
    this.engine = new FakeRuntimeEngine(initialScenario, "demo");
    this.client = new InProcessLauncherClient(this.engine);
  }

  public switchScenario(scenario: ScenarioName): void {
    this.engine.switchScenario(scenario);
  }

  public getSnapshot(): Promise<RuntimeSnapshot> {
    return this.client.getSnapshot();
  }

  public execute(command: ControlCommand): Promise<CommandAck> {
    return this.client.execute(command);
  }

  public getOperation(operationId: string): Promise<OperationRecord> {
    return this.client.getOperation(operationId);
  }

  public getSessions(cursor?: string): Promise<Page<SessionSummary>> {
    return this.client.getSessions(cursor);
  }

  public getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> {
    return this.client.getActivity(query);
  }

  public subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
    return this.client.subscribe(onEvent);
  }
}

