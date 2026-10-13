import { requireViewer } from "$lib/server/dashboard/guard";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => ({ viewer: await requireViewer(event), mcpUrl: event.locals.deps.mcpUrl });
