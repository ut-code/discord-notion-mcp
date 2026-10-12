import { error } from "@sveltejs/kit";
import { signInErrorMessage } from "$lib/server/admin/session";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  error(400, { title: "ログインできませんでした", message: signInErrorMessage(url.searchParams.get("error")) });
};
