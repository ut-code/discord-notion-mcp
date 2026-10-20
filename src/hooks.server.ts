import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { m } from "#lib/paraglide/messages.js";
import { getLocale } from "#lib/paraglide/runtime.js";
import { checkViewer, type ViewerGate } from "#lib/server/dashboard/access.js";
import { withPageLang } from "#lib/server/page-lang.js";
import { errorMessage } from "#lib/server/lib/errors.js";
import { ensureStarted } from "#lib/server/runtime.js";
import { THEME_COOKIE, themeFromCookie, withThemeClass } from "#lib/server/theme.js";

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
  return server.withSecurityHeaders(
    await resolve(event, { transformPageChunk: ({ html }) => withPageLang(withThemeClass(html, theme), getLocale()) }),
  );
};

export const handleError: HandleServerError = async (caught) => {
  // Thrown with error(...): shown as written, not logged.
  if (caught.kind === "app") return;
  if (caught.kind !== "framework" || caught.error.status !== 404) {
    const { server } = await ensureStarted();
    server.logError({ event: "http_error", path: caught.event.url.pathname, error: errorMessage(caught.error) });
  }
  return { message: m.error_unexpected() };
};
