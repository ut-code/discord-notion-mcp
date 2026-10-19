import { requireViewer } from "#lib/server/dashboard/guard.js";
import { toolsPage } from "#lib/server/dashboard/tools.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => toolsPage(event.locals.deps, await requireViewer(event));
