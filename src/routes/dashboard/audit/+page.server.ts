import { auditList } from "#lib/server/dashboard/audit.js";
import { requireAuditViewer } from "#lib/server/dashboard/guard.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  return auditList(event.locals.deps, event.url.searchParams, await requireAuditViewer(event));
};
