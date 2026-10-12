import { error } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { ADMIN_PATH } from "$lib/paths";
import type { RequestHandler } from "./$types";

const ADMIN_NEXT = /^\/admin(\/[\w/-]*)?(\?[\w=&%-]*)?$/;

// Preview only: signs in as a sample user with a new session, then opens an admin page.
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!dev || !locals.preview) error(404, { message: "ページが見つかりません。" });
  const cookie = await locals.preview.sessionCookie(url.searchParams.get("as") ?? locals.preview.users[0]?.id ?? "");
  if (!cookie) error(400, { message: "unknown user" });
  const next = url.searchParams.get("next") ?? "";
  return new Response(null, { status: 302, headers: { location: ADMIN_NEXT.test(next) ? next : ADMIN_PATH, "set-cookie": cookie } });
};
