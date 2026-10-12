import { error, fail } from "@sveltejs/kit";
import { auditDetail, revertAudit } from "$lib/server/admin/audit";
import { requireAuditViewer } from "$lib/server/admin/guard";
import type { Actions, PageServerLoad } from "./$types";

const NOT_FOUND = { title: "見つかりません", message: "指定された履歴はありません。", signedIn: true };

export const load: PageServerLoad = async (event) => {
  const viewer = await requireAuditViewer(event);
  const detail = await auditDetail(event.locals.deps, event.params.id, viewer);
  if (!detail) error(404, NOT_FOUND);
  return detail;
};

export const actions: Actions = {
  revert: async (event) => {
    const viewer = await requireAuditViewer(event);
    const result = await revertAudit(event.locals.deps, event.params.id, await event.request.formData(), viewer);
    if (result.kind === "not-found") error(404, NOT_FOUND);
    const { conflict, ...feedback } = result;
    return result.kind === "ok" ? { result: feedback, conflict } : fail(feedback.status ?? 400, { result: feedback, conflict });
  },
};
