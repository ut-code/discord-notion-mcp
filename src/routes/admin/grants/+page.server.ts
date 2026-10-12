import { fail } from "@sveltejs/kit";
import { createGrant, deleteGrant, grantsPage } from "$lib/server/admin/grants";
import { requireAdmin } from "$lib/server/admin/guard";
import type { ActionResult } from "$lib/server/admin/shared";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAdmin(event);
  return grantsPage(event.locals.deps, event.url.searchParams);
};

const respond = (result: ActionResult) => (result.kind === "ok" ? { result } : fail(400, { result }));

export const actions: Actions = {
  create: async (event) => {
    const admin = await requireAdmin(event);
    return respond(await createGrant(event.locals.deps, await event.request.formData(), admin));
  },
  delete: async (event) => {
    const admin = await requireAdmin(event);
    return respond(await deleteGrant(event.locals.deps, await event.request.formData(), admin));
  },
};
