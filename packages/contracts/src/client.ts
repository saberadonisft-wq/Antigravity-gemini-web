import type { RuntimeSnapshot } from "./snapshot.js";
import type { ControlCommand, CommandAck } from "./commands.js";
import type { OperationRecord } from "./operations.js";
import type { SessionSummary } from "./sessions.js";
import type { ActivityEntry, ActivityQuery, Page } from "./activity.js";
import type { RuntimeEvent } from "./events.js";

export interface LauncherClient {
  getSnapshot(): Promise<RuntimeSnapshot>;
  execute(command: ControlCommand): Promise<CommandAck>;
  getOperation(operationId: string): Promise<OperationRecord>;
  getSessions(cursor?: string): Promise<Page<SessionSummary>>;
  getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>>;
  subscribe(onEvent: (event: RuntimeEvent) => void): () => void;
}

