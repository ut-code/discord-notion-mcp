import { redirect } from "@sveltejs/kit";
import { SIGN_IN_PATH } from "$lib/paths";
import { signOut } from "$lib/server/dashboard/session";
import { formString } from "$lib/server/dashboard/shared";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  redirect(303, SIGN_IN_PATH);
};

// Not behind the admin check: signed-in non-admins and the consent page switch accounts here.
export const actions: Actions = {
  default: async ({ locals, request, cookies }) => {
    const form = await request.formData();
    const result = await signOut(locals.deps, request.headers, formString(form, "next"));
    for (const cookie of result.cookies) cookies.set(cookie.name, cookie.value, cookie.options);
    redirect(303, result.location);
  },
};
