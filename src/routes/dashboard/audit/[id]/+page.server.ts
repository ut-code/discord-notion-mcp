import { auditDetail, AUDIT_NOT_FOUND, revertAudit } from "#lib/server/dashboard/audit.js";
import { orNotFound, requireAuditViewer, respond } from "#lib/server/dashboard/guard.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) =>
  orNotFound(await auditDetail(event.locals.deps, event.params.id, await requireAuditViewer(event)), AUDIT_NOT_FOUND);

export const actions: Actions = {
  revert: async (event) => {
    const viewer = await requireAuditViewer(event);
    const { result, conflict } = orNotFound(
      await revertAudit(event.locals.deps, event.params.id, await event.request.formData(), viewer),
      AUDIT_NOT_FOUND,
    );
    return respond(result, { conflict });
  },
};
