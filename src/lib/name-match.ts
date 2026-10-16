// Name search shared by the server (members) and the grant form (roles): width, case and a leading @ do not matter.

/** Longest search query the member search accepts. */
export const MAX_QUERY_LENGTH = 100;

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The search needle for a query; empty when there is nothing to search for. */
export function searchNeedle(query: string): string {
  return fold(query.trim().replace(/^@/, ""));
}

/** Whether any of the names contains the needle. */
export function namesMatch(names: ReadonlyArray<string | null | undefined>, needle: string): boolean {
  return names.some((name) => name != null && fold(name).includes(needle));
}
