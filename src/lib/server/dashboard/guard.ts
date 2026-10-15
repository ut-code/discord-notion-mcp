import { error, fail, redirect } from "@sveltejs/kit";
import { m } from "../../paraglide/messages.js";
import { signInRedirect, type Viewer } from "./access";
import type { ActionResult } from "./shared";

interface GuardEvent {
  locals: App.Locals;
  url: URL;
  request: Request;
}

/** Dashboard pages and actions: redirects to sign-in, or renders the 403/503 error page. */
export async function requireViewer({ locals, url, request }: GuardEvent): Promise<Viewer> {
  const gate = await locals.viewerGate();
  if (gate.kind === "signed-out") redirect(302, signInRedirect(url, request.method));
  if (gate.kind === "denied") error(gate.status, { title: gate.title, message: gate.message, signedIn: true });
  return gate.viewer;
}

/** Dashboard JSON endpoints: like requireViewer, but 401 instead of a sign-in redirect. */
export async function requireApiViewer({ locals }: Pick<GuardEvent, "locals">): Promise<Viewer> {
  const gate = await locals.viewerGate();
  if (gate.kind === "signed-out") error(401, { message: m.access_sign_in_required() });
  if (gate.kind === "denied") error(gate.status, { title: gate.title, message: gate.message });
  return gate.viewer;
}

/** The write history: notion:write (their own writes) or admin (everyone's). */
export async function requireAuditViewer(event: GuardEvent): Promise<Viewer> {
  const viewer = await requireViewer(event);
  if (!viewer.canViewAudit) {
    error(403, { title: m.access_denied_title(), message: m.access_audit_requires_notion_write(), signedIn: true });
  }
  return viewer;
}

/** Pages only admins open (grants). */
export async function requireAdminViewer(event: GuardEvent): Promise<Viewer> {
  const viewer = await requireViewer(event);
  if (!viewer.isAdmin) {
    error(403, { title: m.access_denied_title(), message: m.access_admin_only_page(), signedIn: true });
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
  const body: E & { result: T } = Object.assign({}, extra, { result });
  return result.kind === "ok" ? body : fail(result.status ?? 400, body);
}
