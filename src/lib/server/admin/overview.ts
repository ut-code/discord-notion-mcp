import { auditListHref, auditRowView, type AuditRowView } from "./audit";
import type { AdminDeps } from "./deps";

const RECENT_WRITES = 5;
const RECENT_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface OverviewData {
  /** Unreverted failed writes in the last 7 days. */
  recentFailures: number;
  failuresHref: string;
  recent: AuditRowView[];
  mcpUrl: string;
}

export async function overview(deps: AdminDeps, now = Date.now()): Promise<OverviewData> {
  const since = new Date(now - RECENT_FAILURE_WINDOW_MS);
  const [failures, recent] = await Promise.all([
    deps.audit.listAudit({ limit: 1, status: "failed", reverted: false, since }),
    deps.audit.listAudit({ limit: RECENT_WRITES }),
  ]);
  return {
    recentFailures: failures.total,
    failuresHref: auditListHref({ status: "failed" }),
    recent: recent.rows.map((row) => auditRowView(row)),
    mcpUrl: deps.mcpUrl,
  };
}
