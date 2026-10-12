import { auditList } from "$lib/server/dashboard/audit";
import { requireAuditViewer } from "$lib/server/dashboard/guard";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAuditViewer(event);
  return auditList(event.locals.deps, event.url.searchParams);
};
