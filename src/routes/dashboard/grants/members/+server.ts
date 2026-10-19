import { memberSearchResult } from "#lib/server/dashboard/grants.js";
import { requireApiViewer } from "#lib/server/dashboard/guard.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const { status, body } = await memberSearchResult(event.locals.deps, event.url.searchParams.get("q"), await requireApiViewer(event));
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
};
