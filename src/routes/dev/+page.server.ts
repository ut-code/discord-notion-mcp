import { error } from "@sveltejs/kit";
import { dev } from "$app/environment";
import type { PageServerLoad } from "./$types";

// Preview only: `dev` is false in production builds and `locals.preview` needs PREVIEW=1.
export const load: PageServerLoad = ({ locals }) => {
  if (!dev || !locals.preview) error(404, { message: "ページが見つかりません。" });
  return { users: locals.preview.users };
};
