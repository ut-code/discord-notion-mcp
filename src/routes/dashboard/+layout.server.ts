import { requireViewer } from "#lib/server/dashboard/guard.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => ({ viewer: await requireViewer(event), mcpUrl: event.locals.deps.mcpUrl });
