import { error } from "@sveltejs/kit";
import { consentPage } from "$lib/server/dashboard/session";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url, request }) => {
  const result = await consentPage(locals.deps, url, request.headers);
  if (result.kind === "error") error(result.status, { title: result.title, message: result.message });
  return result.data;
};
