import { auditList } from "$lib/server/admin/audit";
import { requireAdmin } from "$lib/server/admin/guard";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAdmin(event);
  return auditList(event.locals.deps, event.url.searchParams);
};
