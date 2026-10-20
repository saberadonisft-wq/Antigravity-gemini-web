import { type LauncherClient, type ControlCommand, type CommandAck, isTerminalOperationState, type UiError } from "@antigravity-gemini-web/contracts";

export async function executeAndWait(client: LauncherClient, command: ControlCommand, budgetMs = 20000): Promise<CommandAck> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 20000) throw new RangeError("Invalid operation budget.");
  const deadline = Date.now() + budgetMs;
  const observe = async <T>(job: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([job, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject({ code: "OUTCOME_UNKNOWN", message: "Operation deadline exceeded; reconcile its status before retrying.", retryable: false } satisfies UiError), Math.max(1, deadline - Date.now()));
    })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const ack = await observe(client.execute(command));
  if (!ack.accepted) return ack;
  while (Date.now() < deadline) {
    const operation = await observe(client.getOperation(ack.operationId));
    if (isTerminalOperationState(operation.state)) {
      if (operation.state !== "succeeded") return { requestId: command.requestId, accepted: false, error: operation.error ?? { code: "OUTCOME_UNKNOWN", message: "Kết quả thao tác chưa xác định.", retryable: false } satisfies UiError };
      return ack;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100)); // observation cadence, never a success timer
  }
  throw { code: "OUTCOME_UNKNOWN", message: "Chưa nhận được kết quả; kiểm tra nhật ký trước khi thử lại.", retryable: false } satisfies UiError;
}
