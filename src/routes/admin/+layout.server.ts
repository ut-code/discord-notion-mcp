import { requireAdmin } from "$lib/server/admin/guard";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => ({ admin: await requireAdmin(event) });
