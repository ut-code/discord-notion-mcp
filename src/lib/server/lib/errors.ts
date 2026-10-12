/** An error whose message is safe to show to the MCP client as a tool error result. */
export class ToolError extends Error {
  override name = "ToolError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
