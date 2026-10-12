import { error, redirect } from "@sveltejs/kit";
import { signInRedirect, type AdminView } from "./access";

interface GuardEvent {
  locals: App.Locals;
  url: URL;
  request: Request;
}

/** Admin pages and actions: redirects to sign-in, or renders the 403/503 error page. */
export async function requireAdmin({ locals, url, request }: GuardEvent): Promise<AdminView> {
  const gate = await locals.admin();
  if (gate.kind === "signed-out") redirect(302, signInRedirect(url, request.method));
  if (gate.kind === "denied") error(gate.status, { title: gate.title, message: gate.message, signedIn: true });
  return gate.admin;
}
