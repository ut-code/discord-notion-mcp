import { requireAdmin } from "$lib/server/admin/guard";
import { overview } from "$lib/server/admin/overview";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  await requireAdmin(event);
  return overview(event.locals.deps);
};
