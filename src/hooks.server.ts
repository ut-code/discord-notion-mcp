import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit";
import { checkViewer, type ViewerGate } from "$lib/server/dashboard/access";
import { withSecurityHeaders } from "$lib/server/http";
import { errorMessage } from "$lib/server/lib/errors";
import { ensureStarted } from "$lib/server/runtime";
import { THEME_COOKIE, themeFromCookie, withThemeClass } from "$lib/server/theme";

export const init: ServerInit = async () => {
  await ensureStarted();
};

export const handle: Handle = async ({ event, resolve }) => {
  const { server, preview } = await ensureStarted();

  const early = await server.http(event.request, () => event.getClientAddress());
  if (early) return early;

  let gate: Promise<ViewerGate> | undefined;
  event.locals.deps = server.dashboard;
  event.locals.viewerGate = () => (gate ??= checkViewer(server.dashboard, event.request.headers));
  event.locals.preview = preview;
  const theme = themeFromCookie(event.cookies.get(THEME_COOKIE));
  event.locals.theme = theme;
  return withSecurityHeaders(await resolve(event, { transformPageChunk: ({ html }) => withThemeClass(html, theme) }));
};

export const handleError: HandleServerError = async ({ error, event, status }) => {
  if (status !== 404) {
    const { server } = await ensureStarted();
    server.logError({ event: "http_error", path: event.url.pathname, error: errorMessage(error) });
  }
  return { message: "予期しないエラーが発生しました。しばらくしてから再度お試しください。" };
};
