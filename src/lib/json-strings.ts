import { isRecord } from "./guards";

/** The string fields of a JSON response body; a non-JSON or non-object body reads as empty. */
export async function jsonStrings(response: Response): Promise<Record<string, string>> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return {};
  return Object.fromEntries(Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
