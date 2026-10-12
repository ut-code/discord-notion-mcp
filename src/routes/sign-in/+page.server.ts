import { signInPage } from "$lib/server/admin/session";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => signInPage(locals.deps, url);
