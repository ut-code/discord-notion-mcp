import { requireViewer } from "$lib/server/dashboard/guard";
import { overview } from "$lib/server/dashboard/overview";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => overview(event.locals.deps, await requireViewer(event));
