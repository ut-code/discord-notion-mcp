import { requireViewer } from "$lib/server/admin/guard";
import { statsPage } from "$lib/server/admin/stats";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireViewer(event);
  return statsPage(event.locals.deps, event.url.searchParams);
};
