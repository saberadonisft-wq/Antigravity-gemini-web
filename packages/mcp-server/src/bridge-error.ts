export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
