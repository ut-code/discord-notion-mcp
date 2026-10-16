/**
 * An error whose message is safe to show to the MCP client as a tool error result.
 * `logMessage` is what logs and usage statistics keep: server-composed text without page or
 * message content. It differs from the message only where an upstream error is passed on.
 */
export class ToolError extends Error {
  override name = "ToolError";
  readonly logMessage: string;

  constructor(message: string, options: { logMessage?: string } = {}) {
    super(message);
    this.logMessage = options.logMessage ?? message;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
