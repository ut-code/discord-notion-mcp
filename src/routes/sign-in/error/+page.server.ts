import { error } from "@sveltejs/kit";
import { m } from "#lib/paraglide/messages.js";
import { signInErrorMessage } from "#lib/server/dashboard/session.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  error(400, signInErrorMessage(url.searchParams.get("error")), { title: m.sign_in_failed_title() });
};
