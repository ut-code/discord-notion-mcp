import { grantSubmitLabel } from "../../grant-label";
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
import { grantableRoles, heldRoles, subjectFromMember, type UserSubject } from "./subjects";
import { buildGrantRows, type GrantRowView, type Redundancy } from "./views";

export const GRANTS_PATH = `${DASHBOARD_PATH}/grants`;
const SEARCH_LIMIT = 10;

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
  /** Who granted it; implicit admins name the source instead. */
  grantedBy: string;
  grantedAt: string;
  /** Tooltip of a row that cannot be deleted here. */
  locked: string | null;
  /** Null for locked rows and for non-admin viewers. */
  remove: { permission: Permission; subjectType: SubjectType; subjectId: string; label: string; menuLabel: string; confirm: string } | null;
}

export interface CandidateView {
  id: string;
  name: string;
  secondLine: string;
  avatarUrl: string | null;
}

export interface GrantFormView {
  permissions: Array<{ value: Permission; label: string; hint: string }>;
  permission: Permission;
  subjectType: SubjectType;
  roles: Array<{ id: string; name: string; handle: string }>;
  roleId: string;
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
  /** Admins only. */
  form: GrantFormView | null;
}

function rolesText(guild: GuildInfo, user: UserSubject): string {
  if (!user.member) return "非メンバー";
  const names = heldRoles(guild, user.member).map((role) => role.name);
  return names.length > 0 ? names.join(", ") : "ロールなし";
}

function userSecondLine(guild: GuildInfo, user: UserSubject): string {
  return user.username ? `@${user.username} · ${rolesText(guild, user)}` : rolesText(guild, user);
}

function roleSubject(role: RoleInfo | null, fallbackId: string): SubjectView {
  return {
    kind: "role",
    name: role ? roleHandle(role.name) : fallbackId,
    secondary: role ? "ロール" : "削除済みロール",
    unknown: false,
    color: role ? (roleColor(role.color) ?? null) : null,
    avatarUrl: null,
    title: null,
  };
}

function userSubject(guild: GuildInfo, user: UserSubject | null, fallbackId: string): SubjectView {
  if (!user?.displayName) {
    return { kind: "user", name: fallbackId, secondary: "不明なユーザー", unknown: true, color: null, avatarUrl: null, title: null };
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

function redundancyBadge(redundancy: Redundancy): BadgeView {
  const role = redundancy.kind === "role" ? roleHandle(redundancy.role.name) : null;
  return {
    label: role ? `${role} で付与済み` : "管理者で付与済み",
    tone: "warn",
    title: role
      ? `この権限は ${role} ロールで既に付与されているため、この個人付与は効果がありません`
      : "この権限は管理者として既に付与されているため、この個人付与は効果がありません",
  };
}

function tableRow(guild: GuildInfo, row: GrantRowView): GrantTableRow {
  if (row.kind === "admin-role") {
    return {
      key: `admin-role:${row.role.id}`,
      subject: roleSubject(row.role, row.role.id),
      permissionLabel: PERMISSION_LABELS.admin,
      redundancy: null,
      grantedBy: "Discord の Administrator 権限",
      grantedAt: "—",
      locked: "Discord 側の権限なのでここでは削除できません",
      remove: null,
    };
  }
  if (row.kind === "owner") {
    return {
      key: `owner:${row.user.id}`,
      subject: userSubject(guild, row.user, row.user.id),
      permissionLabel: PERMISSION_LABELS.admin,
      redundancy: null,
      grantedBy: "サーバーオーナー",
      grantedAt: "—",
      locked: "サーバーオーナーは常に管理者です",
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
    grantedBy: row.createdBy ? (row.createdBy.displayName ?? row.createdBy.id) : "—",
    grantedAt: formatDateJst(grant.createdAt),
    locked: null,
    remove: {
      permission: grant.permission,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      label: `${subjectLabel} の ${label}を削除`,
      menuLabel: `${subjectLabel} の ${label}の操作`,
      confirm: `${subjectLabel} の ${label}を削除しますか？`,
    },
  };
}

/** Member search for the grant form: a Discord id resolves directly, anything else is a name prefix. */
async function searchCandidates(deps: DashboardDeps, query: string): Promise<{ candidates: UserSubject[]; error: string | null }> {
  const needle = query.replace(/^@/, "");
  if (isSnowflake(needle)) {
    const subject = await deps.subjects.resolveUser(needle);
    return { candidates: subject.displayName ? [subject] : [], error: null };
  }
  try {
    const members = await deps.discord.searchMembers(needle, SEARCH_LIMIT);
    return { candidates: members.map(subjectFromMember), error: null };
  } catch (error) {
    deps.logError({ event: "admin_lookup_failed", lookup: "member_search", error: errorMessage(error) });
    return { candidates: [], error: "メンバー検索に失敗しました。しばらくしてから再試行してください。" };
  }
}

/** Query: `filter` (tab), and the grant form state `permission`, `subjectType`, `roleId`, `q`, `userId` (admins only). */
export async function grantsPage(deps: DashboardDeps, params: URLSearchParams, viewer: Viewer): Promise<GrantsPageData> {
  const [guild, grants] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants()]);
  const filterParam = params.get("filter") ?? "";
  const filter = isPermission(filterParam) ? filterParam : null;
  const query = viewer.isAdmin ? (params.get("q")?.trim() ?? "") : "";
  const userParam = params.get("userId")?.trim() ?? "";
  const selectedUserId = viewer.isAdmin && isSnowflake(userParam) ? userParam : null;

  const userIds = grants.flatMap((grant) => [
    ...(grant.subjectType === "user" ? [grant.subjectId] : []),
    ...(grant.createdBy ? [grant.createdBy] : []),
  ]);
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
      label: value ? PERMISSION_LABELS[value] : "すべて",
      count: value ? null : allRows.length,
      href: value ? `${GRANTS_PATH}?filter=${encodeURIComponent(value)}` : GRANTS_PATH,
      active: filter === value,
    })),
    rows: viewer.isAdmin ? rows : rows.map((row) => ({ ...row, remove: null })),
    form: viewer.isAdmin ? grantForm(guild, params, filter, { query, selectedUserId, users, search }) : null,
  };
}

interface FormLookups {
  query: string;
  selectedUserId: string | null;
  users: ReadonlyMap<string, UserSubject>;
  search: { candidates: UserSubject[]; error: string | null };
}

function grantForm(guild: GuildInfo, params: URLSearchParams, filter: Permission | null, lookups: FormLookups): GrantFormView {
  const { query, selectedUserId, users, search } = lookups;
  const permissionParam = params.get("permission") ?? "";
  const typeParam = params.get("subjectType");
  const subjectType: SubjectType = typeParam === "role" || typeParam === "user" ? typeParam : query || selectedUserId ? "user" : "role";
  const roles = grantableRoles(guild);
  const roleParam = params.get("roleId") ?? "";
  const selected = selectedUserId ? users.get(selectedUserId) : undefined;
  const candidates =
    selected?.displayName && !search.candidates.some((candidate) => candidate.id === selected.id) ? [selected, ...search.candidates] : search.candidates;

  const permission = isPermission(permissionParam) ? permissionParam : (filter ?? "discord:read");
  const role = roles.find((candidate) => candidate.id === roleParam) ?? roles[0];
  const candidateViews = candidates.map((user) => ({
    id: user.id,
    name: user.displayName ?? user.id,
    secondLine: userSecondLine(guild, user),
    avatarUrl: user.avatarUrl,
  }));
  // Candidates always carry a resolved display name.
  const selectedName = candidateViews.find((candidate) => candidate.id === selectedUserId)?.name ?? null;
  const target = subjectType === "role" ? (role ? roleHandle(role.name) : null) : selectedName;

  return {
    permissions: PERMISSIONS.map((value) => ({ value, label: PERMISSION_LABELS[value], hint: PERMISSION_HINTS[value] })),
    permission,
    subjectType,
    roles: roles.map((candidate) => ({ id: candidate.id, name: candidate.name, handle: roleHandle(candidate.name) })),
    roleId: role?.id ?? "",
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
  if (!isPermission(permission)) return { ok: false, message: "不明な権限です。" };
  if (subjectType !== "role" && subjectType !== "user") return { ok: false, message: "対象の種類が不正です。" };
  const subjectId = formString(body, "subjectId") || formString(body, subjectType === "role" ? "roleId" : "userId");
  if (!subjectId) return { ok: false, message: subjectType === "role" ? "ロールを選んでください。" : "ユーザーを選んでください。" };
  if (!isSnowflake(subjectId)) return { ok: false, message: `「${subjectId}」は Discord の ID（15〜22 桁の数字）ではありません。` };
  if (subjectType === "user") {
    const user = await deps.subjects.resolveUser(subjectId);
    const label = user.displayName ? `ユーザー「${user.displayName}」` : `ユーザー ${subjectId}`;
    return { ok: true, form: { permission, subjectType, subjectId, label } };
  }
  const role = (await deps.directory.fetchGuild()).roles.find((candidate) => candidate.id === subjectId);
  return { ok: true, form: { permission, subjectType, subjectId, role, label: role ? `ロール「${role.name}」` : `ロール ${subjectId}` } };
}

export async function createGrant(deps: DashboardDeps, body: FormData, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const parsed = await parseGrantForm(deps, body);
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const { form } = parsed;
  if (form.subjectType === "role" && (!form.role || form.role.managed)) {
    return { kind: "error", message: "このサーバーに存在する（連携用でない）ロールを選んでください。" };
  }
  const by = actor.discordUserId;
  const { created } = await deps.grants.createGrant({ permission: form.permission, subjectType: form.subjectType, subjectId: form.subjectId, createdBy: by });
  if (!created) return { kind: "warn", message: `${form.label}には既に「${PERMISSION_LABELS[form.permission]}」が付与されています。` };
  deps.log({ event: "grant_added", permission: form.permission, subjectType: form.subjectType, subjectId: form.subjectId, by });
  return { kind: "ok", message: `${form.label}に「${PERMISSION_LABELS[form.permission]}」を付与しました。` };
}

export async function deleteGrant(deps: DashboardDeps, body: FormData, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const parsed = await parseGrantForm(deps, body);
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const { form } = parsed;
  const removed = await deps.grants.removeGrant(form);
  if (!removed) return { kind: "warn", message: "この付与は既に削除されています。" };
  deps.log({ event: "grant_removed", permission: form.permission, subjectType: form.subjectType, subjectId: form.subjectId, by: actor.discordUserId });
  const subject = form.role ? roleHandle(form.role.name) : form.label;
  return { kind: "ok", message: `${subject} から「${PERMISSION_LABELS[form.permission]}」を削除しました。` };
}
