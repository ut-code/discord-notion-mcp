import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit";
import { checkViewer, type ViewerGate } from "$lib/server/dashboard/access";
import { isCrossOriginWrite, withSecurityHeaders } from "$lib/server/http";
import { errorMessage } from "$lib/server/lib/errors";
import { runtime } from "$lib/server/runtime";

export const init: ServerInit = async () => {
  await runtime();
};

export const handle: Handle = async ({ event, resolve }) => {
  const { composed, preview } = await runtime();

  const api = await composed.http(event.request, () => event.getClientAddress());
  if (api) return api;

  if (isCrossOriginWrite(event.request, new URL(composed.publicUrl).origin)) {
    return withSecurityHeaders(new Response("Forbidden", { status: 403 }));
  }

  let gate: Promise<ViewerGate> | undefined;
  event.locals.deps = composed.dashboard;
  event.locals.viewer = () => (gate ??= checkViewer(composed.dashboard, event.request.headers));
  event.locals.preview = preview;
  return withSecurityHeaders(await resolve(event));
};

export const handleError: HandleServerError = async ({ error, event, status }) => {
  if (status !== 404) {
    const { composed } = await runtime();
    composed.logError({ event: "http_error", path: event.url.pathname, error: errorMessage(error) });
  }
  return { message: "予期しないエラーが発生しました。しばらくしてから再度お試しください。" };
};
