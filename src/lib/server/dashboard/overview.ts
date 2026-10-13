import type { Viewer } from "./access";
import { auditListHref, auditRowView, type AuditRowView } from "./audit";
import type { DashboardDeps } from "./deps";

const RECENT_WRITES = 5;
const RECENT_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface OverviewData {
  /** Unreverted failed writes in the last 7 days; 0 for viewers who cannot open the write history. */
  recentFailures: number;
  failuresHref: string;
  /** Null for viewers who cannot open the write history (it shows Notion page titles). */
  recent: AuditRowView[] | null;
  /** The "権限を付与" shortcut. */
  canGrant: boolean;
}

export async function overview(
  deps: DashboardDeps,
  viewer: Pick<Viewer, "isAdmin" | "canViewAudit">,
  now = Date.now(),
): Promise<OverviewData> {
  const base = { failuresHref: auditListHref({ status: "failed" }), canGrant: viewer.isAdmin };
  if (!viewer.canViewAudit) return { ...base, recentFailures: 0, recent: null };
  const since = new Date(now - RECENT_FAILURE_WINDOW_MS);
  const [failures, recent] = await Promise.all([
    deps.audit.listAudit({ limit: 1, status: "failed", reverted: false, since }),
    deps.audit.listAudit({ limit: RECENT_WRITES }),
  ]);
  return { ...base, recentFailures: failures.total, recent: recent.rows.map((row) => auditRowView(row)) };
}
