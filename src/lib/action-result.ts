import type { ActionResult } from "$lib/server/dashboard/shared";
import { isRecord } from "./guards";
import { isOneOf } from "./one-of";

const KINDS = ["ok", "warn", "error"] as const;

/** The `result` of the last dashboard form action; SvelteKit types `page.form` as `any`. */
export function actionResultOf(form: unknown): ActionResult | undefined {
  const result = isRecord(form) ? form.result : undefined;
  if (!isRecord(result) || !isOneOf(KINDS, result.kind)) return undefined;
  const message = result.message;
  if (typeof message !== "string" && message !== null) return undefined;
  return { kind: result.kind, message };
}
