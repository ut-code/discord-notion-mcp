import { redirect } from "@sveltejs/kit";
import { parseThemeForm, THEME_COOKIE, THEME_COOKIE_OPTIONS } from "#lib/server/theme.js";
import type { RequestHandler } from "./$types";

// Cross-origin posts are rejected by the HTTP handler (http.ts) before reaching this one.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const form = parseThemeForm(await request.formData().catch(() => new FormData()));
  if (!form) return new Response("Bad Request", { status: 400 });
  cookies.set(THEME_COOKIE, form.theme, THEME_COOKIE_OPTIONS);
  redirect(303, form.location);
};
