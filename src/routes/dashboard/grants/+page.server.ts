import { createGrant, deleteGrant, grantsPage } from "$lib/server/admin/grants";
import { requireViewer, respond } from "$lib/server/admin/guard";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => grantsPage(event.locals.deps, event.url.searchParams, await requireViewer(event));

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
