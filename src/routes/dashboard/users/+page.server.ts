import { requireViewer, respond } from "#lib/server/dashboard/guard.js";
import { formString } from "#lib/server/dashboard/shared.js";
import { revokeTokens, usersPage } from "#lib/server/dashboard/users.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => usersPage(event.locals.deps, event.url.searchParams, await requireViewer(event));

export const actions: Actions = {
  revoke: async (event) => {
    const viewer = await requireViewer(event);
    const form = await event.request.formData();
    return respond(await revokeTokens(event.locals.deps, formString(form, "userId"), viewer));
  },
};
