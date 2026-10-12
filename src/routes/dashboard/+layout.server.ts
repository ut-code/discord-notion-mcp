import { requireViewer } from "$lib/server/admin/guard";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => ({ viewer: await requireViewer(event) });
