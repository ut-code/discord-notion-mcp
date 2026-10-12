import { fail } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/admin/guard";
import { formString } from "$lib/server/admin/shared";
import { revokeTokens, usersPage } from "$lib/server/admin/users";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAdmin(event);
  return usersPage(event.locals.deps, event.url.searchParams);
};

export const actions: Actions = {
  revoke: async (event) => {
    const admin = await requireAdmin(event);
    const form = await event.request.formData();
    const result = await revokeTokens(event.locals.deps, formString(form, "userId"), admin);
    return result.kind === "ok" ? { result } : fail(400, { result });
  },
};
