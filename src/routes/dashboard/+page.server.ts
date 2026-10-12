import { requireViewer } from "$lib/server/admin/guard";
import { overview } from "$lib/server/admin/overview";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => overview(event.locals.deps, await requireViewer(event));
