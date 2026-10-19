import { requireViewer } from "#lib/server/dashboard/guard.js";
import { historyHref } from "#lib/server/dashboard/history.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => {
  const viewer = await requireViewer(event);
  return { viewer, historyHref: historyHref(event.locals.deps, viewer), mcpUrl: event.locals.deps.mcpUrl };
};
