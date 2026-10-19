import { createGrant, deleteGrant, grantsPage } from "#lib/server/dashboard/grants.js";
import { requireAdminViewer, requireViewer, respond } from "#lib/server/dashboard/guard.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAdminViewer(event);
  return grantsPage(event.locals.deps, event.url.searchParams);
};

export const actions: Actions = {
  create: async (event) => {
    const viewer = await requireViewer(event);
    return respond(await createGrant(event.locals.deps, await event.request.formData(), viewer));
  },
  delete: async (event) => {
    const viewer = await requireViewer(event);
    return respond(await deleteGrant(event.locals.deps, await event.request.formData(), viewer));
  },
};
