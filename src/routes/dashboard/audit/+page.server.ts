import { auditList } from "$lib/server/admin/audit";
import { requireAuditViewer } from "$lib/server/admin/guard";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAuditViewer(event);
  return auditList(event.locals.deps, event.url.searchParams);
};
