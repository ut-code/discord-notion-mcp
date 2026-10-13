import { error, fail, redirect } from "@sveltejs/kit";
import { signInRedirect, type Viewer } from "./access";
import type { ActionResult } from "./shared";

interface GuardEvent {
  locals: App.Locals;
  url: URL;
  request: Request;
}

/** Dashboard pages and actions: redirects to sign-in, or renders the 403/503 error page. */
export async function requireViewer({ locals, url, request }: GuardEvent): Promise<Viewer> {
  const gate = await locals.viewer();
  if (gate.kind === "signed-out") redirect(302, signInRedirect(url, request.method));
  if (gate.kind === "denied") error(gate.status, { title: gate.title, message: gate.message, signedIn: true });
  return gate.viewer;
}

/** Dashboard JSON endpoints: like requireViewer, but 401 instead of a sign-in redirect. */
export async function requireApiViewer({ locals }: Pick<GuardEvent, "locals">): Promise<Viewer> {
  const gate = await locals.viewer();
  if (gate.kind === "signed-out") error(401, { message: "ログインが必要です。" });
  if (gate.kind === "denied") error(gate.status, { title: gate.title, message: gate.message });
  return gate.viewer;
}

/** The write history shows Notion content: notion:read or admin. */
export async function requireAuditViewer(event: GuardEvent): Promise<Viewer> {
  const viewer = await requireViewer(event);
  if (!viewer.canViewAudit) {
    error(403, { title: "アクセスできません", message: "書き込み履歴を見るには Notion 読み取りの権限が必要です。", signedIn: true });
  }
  return viewer;
}

/** Renders the 404 page when the requested entity does not exist (null). */
export function orNotFound<T>(value: T | null, page: { title: string; message: string }): T {
  if (value === null) error(404, { ...page, signedIn: true });
  return value;
}

/**
 * Action response: the result on success, otherwise a failure with its status (403 for
 * non-admins, else 400). `extra` fields are sent next to the result either way.
 */
export function respond<T extends ActionResult, E extends object = Record<never, never>>(result: T, extra?: E) {
  const body = { ...extra, result } as E & { result: T };
  return result.kind === "ok" ? body : fail(result.status ?? 400, body);
}
