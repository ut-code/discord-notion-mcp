import { requireViewer } from "#lib/server/dashboard/guard.js";
import { statsPage } from "#lib/server/dashboard/stats.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireViewer(event);
  return statsPage(event.locals.deps, event.url.searchParams);
};
