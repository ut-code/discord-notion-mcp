import { channelsSection } from "#lib/server/dashboard/channels.js";
import { requireViewer } from "#lib/server/dashboard/guard.js";
import { toolsPage } from "#lib/server/dashboard/tools.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const viewer = await requireViewer(event);
  return { ...toolsPage(event.locals.deps, viewer), channels: await channelsSection(event.locals.deps, viewer) };
};
