import { error } from "@sveltejs/kit";
import { NOT_MEMBER } from "$lib/server/dashboard/session";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  error(403, NOT_MEMBER);
};
