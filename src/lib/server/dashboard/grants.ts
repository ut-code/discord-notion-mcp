import { grantSubmitLabel } from "../../grant-label";
import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH } from "../../paths";
import { isPermission, PERMISSIONS, type Permission, type SubjectType } from "../permissions/permissions";
import type { GuildInfo, RoleInfo } from "../discord/types";
import { errorMessage } from "../lib/errors";
import { isSnowflake } from "../lib/snowflake";
import { ADMIN_ONLY, type Viewer } from "./access";
import type { BadgeView } from "./badges";
import type { DashboardDeps } from "./deps";
import { formatDateJst, PERMISSION_HINTS, PERMISSION_LABELS, roleColor, roleHandle } from "./format";
import { formString, type ActionResult } from "./shared";
import { grantableRoles, heldRoles, type UserSubject } from "./subjects";
import { buildGrantRows, redundancyOf, type GrantRowView, type Redundancy } from "./views";
import type { GrantRow } from "../db/schema";

export const GRANTS_PATH = `${DASHBOARD_PATH}/grants`;
export const MEMBER_QUERY_MAX_LENGTH = 100;

export interface SubjectView {
  kind: "role" | "user";
  name: string;
  secondary: string;
  /** Unknown users show their raw id in a monospace font. */
  unknown: boolean;
  /** Role color dot. */
  color: string | null;
  avatarUrl: string | null;
  /** Tooltip. */
  title: string | null;
}

export interface GrantTableRow {
  key: string;
  subject: SubjectView;
  permissionLabel: string;
  redundancy: BadgeView | null;
  grantedAt: string;
  /** Tooltip of a row that cannot be deleted here. */
  locked: string | null;
  /** Null for locked rows. */
  remove: { permission: Permission; subjectType: SubjectType; subjectId: string; label: string; menuLabel: string; confirm: string } | null;
}

/** Per permission, why granting it to a subject would add nothing; the form shows it before granting. */
export type GrantNotices = Partial<Record<Permission, string>>;

/** What the form needs to know about a subject before granting it something. */
export interface GrantState {
  /** Permissions granted to exactly this subject; the form does not offer them again. */
  granted: Permission[];
  /** Permissions the subject gets some other way; granting them is allowed but adds nothing. */
  notices: GrantNotices;
}

export interface CandidateView extends GrantState {
  id: string;
  name: string;
  secondLine: string;
  avatarUrl: string | null;
}

export interface GrantFormView {
  permissions: Array<{ value: Permission; label: string; hint: string }>;
  permission: Permission;
  subjectType: SubjectType;
  roles: Array<GrantState & { id: string; name: string; handle: string; color: string | null }>;
  roleId: string;
  preselectedRoleId: string | null;
  query: string;
  /** Search results, with a preselected user first. */
  candidates: CandidateView[];
  selectedUserId: string | null;
  searchError: string | null;
  submitLabel: string;
}

export interface GrantsPageData {
  filter: Permission | null;
  tabs: Array<{ label: string; count: number | null; href: string; active: boolean }>;
  rows: GrantTableRow[];
  form: GrantFormView;
}

function rolesText(guild: GuildInfo, user: UserSubject): string {
  if (!user.member) return m.grants_subject_non_member();
  const names = heldRoles(guild, user.member).map((role) => role.name);
  return names.length > 0 ? names.join(", ") : m.common_no_roles();
}

function userSecondLine(guild: GuildInfo, user: UserSubject): string {
  return user.username ? `@${user.username} · ${rolesText(guild, user)}` : rolesText(guild, user);
}

function roleSubject(role: RoleInfo | null, fallbackId: string): SubjectView {
  return {
    kind: "role",
    name: role ? roleHandle(role.name) : fallbackId,
    secondary: role ? m.common_role() : m.grants_subject_deleted_role(),
    unknown: false,
    color: role ? (roleColor(role.color) ?? null) : null,
    avatarUrl: null,
    title: null,
  };
}

function userSubject(guild: GuildInfo, user: UserSubject | null, fallbackId: string): SubjectView {
  if (!user?.displayName) {
    return {
      kind: "user",
      name: fallbackId,
      secondary: m.grants_subject_unknown_user(),
      unknown: true,
      color: null,
      avatarUrl: null,
      title: null,
    };
  }
  return {
    kind: "user",
    name: user.displayName,
    secondary: userSecondLine(guild, user),
    unknown: false,
    color: null,
    avatarUrl: user.avatarUrl,
    title: `Discord ID ${user.id}`,
  };
}

/** A redundancy as a short label and as a reason clause; the list badge and the form notice both build on these. */
function redundancyText(redundancy: Redundancy): { label: string; because: string } {
  switch (redundancy.kind) {
    case "role": {
      const role = roleHandle(redundancy.role.name);
      return { label: m.grants_redundant_role({ role }), because: m.grants_redundant_role_because({ role }) };
    }
    case "admin":
      return { label: m.grants_redundant_admin(), because: m.grants_redundant_admin_because() };
    case "included": {
      const permission = PERMISSION_LABELS[redundancy.by];
      return { label: m.grants_redundant_included({ permission }), because: m.grants_redundant_included_because({ permission }) };
    }
    default:
      throw new Error(`Unknown redundancy: ${redundancy satisfies never}`);
  }
}

function redundancyBadge(redundancy: Redundancy): BadgeView {
  const { label, because } = redundancyText(redundancy);
  return { label, tone: "warn", title: m.grants_redundant_title({ because }) };
}

function tableRow(guild: GuildInfo, row: GrantRowView): GrantTableRow {
  if (row.kind === "admin-role") {
    return {
      key: `admin-role:${row.role.id}`,
      subject: roleSubject(row.role, row.role.id),
      permissionLabel: PERMISSION_LABELS.admin,
      redundancy: null,
      grantedAt: "—",
      locked: m.grants_locked_admin_role(),
      remove: null,
    };
  }
  if (row.kind === "owner") {
    return {
      key: `owner:${row.user.id}`,
      subject: userSubject(guild, row.user, row.user.id),
      permissionLabel: PERMISSION_LABELS.admin,
      redundancy: null,
      grantedAt: "—",
      locked: m.grants_locked_owner(),
      remove: null,
    };
  }
  const { grant } = row;
  const label = PERMISSION_LABELS[grant.permission];
  const subject = grant.subjectType === "role" ? roleSubject(row.role, grant.subjectId) : userSubject(guild, row.user, grant.subjectId);
  const subjectLabel = row.role ? roleHandle(row.role.name) : (row.user?.displayName ?? grant.subjectId);
  return {
    key: `${grant.subjectType}:${grant.subjectId}:${grant.permission}`,
    subject,
    permissionLabel: label,
    redundancy: row.redundancy ? redundancyBadge(row.redundancy) : null,
    grantedAt: formatDateJst(grant.createdAt),
    locked: null,
    remove: {
      permission: grant.permission,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      label: m.grants_remove_label({ subject: subjectLabel, permission: label }),
      menuLabel: m.grants_remove_menu_label({ subject: subjectLabel, permission: label }),
      confirm: m.grants_remove_confirm({ subject: subjectLabel, permission: label }),
    },
  };
}

async function searchCandidates(deps: DashboardDeps, query: string): Promise<{ candidates: UserSubject[]; error: string | null }> {
  try {
    return { candidates: await deps.memberSearch.search(query), error: null };
  } catch (error) {
    deps.logError({ event: "admin_lookup_failed", lookup: "member_search", error: errorMessage(error) });
    return { candidates: [], error: m.grants_member_search_failed_retry() };
  }
}

function grantState(
  guild: GuildInfo,
  grants: readonly GrantRow[],
  subject: { type: SubjectType; id: string; user: UserSubject | null },
): GrantState {
  const granted = grants
    .filter((grant) => grant.subjectType === subject.type && grant.subjectId === subject.id)
    .map((grant) => grant.permission);
  const notices: GrantNotices = {};
  for (const permission of PERMISSIONS) {
    if (granted.includes(permission)) continue;
    const redundancy = redundancyOf(guild, grants, { permission, subjectType: subject.type, subjectId: subject.id }, subject.user);
    if (redundancy) notices[permission] = m.grants_notice_redundant({ because: redundancyText(redundancy).because });
  }
  return { granted, notices };
}

function candidateView(guild: GuildInfo, grants: readonly GrantRow[], user: UserSubject): CandidateView {
  return {
    id: user.id,
    name: user.displayName ?? user.id,
    secondLine: userSecondLine(guild, user),
    avatarUrl: user.avatarUrl,
    ...grantState(guild, grants, { type: "user", id: user.id, user }),
  };
}

export type MemberSearchResult = { status: 200; body: { members: CandidateView[] } } | { status: 400 | 403 | 502; body: { error: string } };

/** JSON member search behind the grant form's inline picker (`GET members?q=`); admins only. */
export async function memberSearchResult(deps: DashboardDeps, rawQuery: string | null, viewer: Viewer): Promise<MemberSearchResult> {
  if (!viewer.isAdmin) return { status: 403, body: { error: ADMIN_ONLY.message ?? "" } };
  const query = rawQuery?.trim() ?? "";
  if (query.length < 1 || query.length > MEMBER_QUERY_MAX_LENGTH) {
    return { status: 400, body: { error: m.grants_member_query_length({ max: MEMBER_QUERY_MAX_LENGTH }) } };
  }
  const [guild, grants, search] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants(), searchCandidates(deps, query)]);
  if (search.error) return { status: 502, body: { error: search.error } };
  return { status: 200, body: { members: search.candidates.map((user) => candidateView(guild, grants, user)) } };
}

/** Admins only (the route checks). Query: `filter` (tab), and the grant form state `permission`, `subjectType`, `roleId`, `q`, `userId`. */
export async function grantsPage(deps: DashboardDeps, params: URLSearchParams): Promise<GrantsPageData> {
  const [guild, grants] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants()]);
  const filterParam = params.get("filter") ?? "";
  const filter = isPermission(filterParam) ? filterParam : null;
  const query = params.get("q")?.trim() ?? "";
  const userParam = params.get("userId")?.trim() ?? "";
  const selectedUserId = isSnowflake(userParam) ? userParam : null;

  const userIds = grants.flatMap((grant) => (grant.subjectType === "user" ? [grant.subjectId] : []));
  const [users, search] = await Promise.all([
    deps.subjects.resolveUsers([...userIds, guild.ownerId, ...(selectedUserId ? [selectedUserId] : [])]),
    query ? searchCandidates(deps, query) : Promise.resolve({ candidates: [], error: null }),
  ]);

  const owner = users.get(guild.ownerId) ?? (await deps.subjects.resolveUser(guild.ownerId));
  const allRows = buildGrantRows(guild, grants, users, owner);
  const visible = filter ? allRows.filter((row) => row.permission === filter) : allRows;
  const rows = visible.map((row) => tableRow(guild, row));

  return {
    filter,
    tabs: [null, ...PERMISSIONS].map((value) => ({
      label: value ? PERMISSION_LABELS[value] : m.grants_tab_all(),
      count: value ? null : allRows.length,
      href: value ? `${GRANTS_PATH}?filter=${encodeURIComponent(value)}` : GRANTS_PATH,
      active: filter === value,
    })),
    rows,
    form: grantForm(guild, params, filter, { grants, query, selectedUserId, users, search }),
  };
}

interface FormLookups {
  grants: readonly GrantRow[];
  query: string;
  selectedUserId: string | null;
  users: ReadonlyMap<string, UserSubject>;
  search: { candidates: UserSubject[]; error: string | null };
}

function grantForm(guild: GuildInfo, params: URLSearchParams, filter: Permission | null, lookups: FormLookups): GrantFormView {
  const { grants, query, selectedUserId, users, search } = lookups;
  const permissionParam = params.get("permission") ?? "";
  const typeParam = params.get("subjectType");
  const subjectType: SubjectType = typeParam === "role" || typeParam === "user" ? typeParam : query || selectedUserId ? "user" : "role";
  const roles = grantableRoles(guild);
  const roleParam = params.get("roleId") ?? "";
  const selected = selectedUserId ? users.get(selectedUserId) : undefined;
  const candidates =
    selected?.displayName && !search.candidates.some((candidate) => candidate.id === selected.id)
      ? [selected, ...search.candidates]
      : search.candidates;

  const permission = isPermission(permissionParam) ? permissionParam : (filter ?? "discord:read");
  const role = roles.find((candidate) => candidate.id === roleParam) ?? roles[0];
  const candidateViews = candidates.map((user) => candidateView(guild, grants, user));
  // Candidates always carry a resolved display name.
  const selectedName = candidateViews.find((candidate) => candidate.id === selectedUserId)?.name ?? null;
  const target = subjectType === "role" ? (role ? roleHandle(role.name) : null) : selectedName;

  return {
    permissions: PERMISSIONS.map((value) => ({ value, label: PERMISSION_LABELS[value], hint: PERMISSION_HINTS[value] })),
    permission,
    subjectType,
    roles: roles.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      handle: roleHandle(candidate.name),
      color: roleColor(candidate.color) ?? null,
      ...grantState(guild, grants, { type: "role", id: candidate.id, user: null }),
    })),
    roleId: role?.id ?? "",
    // Only an explicitly requested role preselects the picker; the no-JS select needs `roleId` regardless.
    preselectedRoleId: roles.some((candidate) => candidate.id === roleParam) ? roleParam : null,
    query,
    candidates: candidateViews,
    selectedUserId,
    searchError: search.error,
    submitLabel: grantSubmitLabel(PERMISSION_LABELS[permission], target),
  };
}

type GrantForm = { permission: Permission; subjectType: SubjectType; subjectId: string; label: string; role?: RoleInfo };
type ParsedGrantForm = { ok: true; form: GrantForm } | { ok: false; message: string };

/** `subjectId` is sent by delete buttons; the grant form sends `roleId` or `userId` per `subjectType`. */
async function parseGrantForm(deps: DashboardDeps, body: FormData): Promise<ParsedGrantForm> {
  const permission = formString(body, "permission");
  const subjectType = formString(body, "subjectType");
  if (!isPermission(permission)) return { ok: false, message: m.grants_unknown_permission() };
  if (subjectType !== "role" && subjectType !== "user") return { ok: false, message: m.grants_invalid_subject_type() };
  const subjectId = formString(body, "subjectId") || formString(body, subjectType === "role" ? "roleId" : "userId");
  if (!subjectId) return { ok: false, message: subjectType === "role" ? m.grants_choose_role() : m.grants_choose_user() };
  if (!isSnowflake(subjectId)) return { ok: false, message: m.grants_invalid_snowflake({ id: subjectId }) };
  if (subjectType === "user") {
    const user = await deps.subjects.resolveUser(subjectId);
    const label = user.displayName ? m.grants_subject_user_named({ name: user.displayName }) : m.grants_subject_user_id({ id: subjectId });
    return { ok: true, form: { permission, subjectType, subjectId, label } };
  }
  const role = (await deps.directory.fetchGuild()).roles.find((candidate) => candidate.id === subjectId);
  const label = role ? m.grants_subject_role_named({ name: role.name }) : m.grants_subject_role_id({ id: subjectId });
  return { ok: true, form: { permission, subjectType, subjectId, role, label } };
}

export async function createGrant(deps: DashboardDeps, body: FormData, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const parsed = await parseGrantForm(deps, body);
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const { form } = parsed;
  if (form.subjectType === "role" && (!form.role || form.role.managed)) {
    return { kind: "error", message: m.grants_role_unavailable() };
  }
  const by = actor.discordUserId;
  const { created } = await deps.grants.createGrant({
    permission: form.permission,
    subjectType: form.subjectType,
    subjectId: form.subjectId,
    createdBy: by,
  });
  const permission = PERMISSION_LABELS[form.permission];
  if (!created) return { kind: "warn", message: m.grants_already_granted({ subject: form.label, permission }) };
  deps.log({ event: "grant_added", permission: form.permission, subjectType: form.subjectType, subjectId: form.subjectId, by });
  return { kind: "ok", message: m.grants_granted({ subject: form.label, permission }) };
}

export async function deleteGrant(deps: DashboardDeps, body: FormData, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const parsed = await parseGrantForm(deps, body);
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const { form } = parsed;
  const removed = await deps.grants.removeGrant(form);
  if (!removed) return { kind: "warn", message: m.grants_already_removed() };
  deps.log({
    event: "grant_removed",
    permission: form.permission,
    subjectType: form.subjectType,
    subjectId: form.subjectId,
    by: actor.discordUserId,
  });
  const subject = form.role ? roleHandle(form.role.name) : form.label;
  return { kind: "ok", message: m.grants_removed({ subject, permission: PERMISSION_LABELS[form.permission] }) };
}
