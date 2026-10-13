import { requireViewer } from "$lib/server/dashboard/guard";
import { statsPage } from "$lib/server/dashboard/stats";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => statsPage(event.locals.deps, event.url.searchParams, await requireViewer(event));
