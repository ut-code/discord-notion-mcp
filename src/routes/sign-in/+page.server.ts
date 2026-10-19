import { signInPage } from "#lib/server/dashboard/session.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => signInPage(locals.deps, url);
