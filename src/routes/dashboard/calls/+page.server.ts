import { error } from "@sveltejs/kit";
import { m } from "#lib/paraglide/messages.js";
import { requireViewer } from "#lib/server/dashboard/guard.js";
import { callsPage } from "#lib/server/dashboard/history.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const data = await callsPage(event.locals.deps, event.url.searchParams, await requireViewer(event));
  if (!data) error(403, m.calls_requires_read(), { title: m.access_denied_title(), signedIn: true });
  return data;
};
