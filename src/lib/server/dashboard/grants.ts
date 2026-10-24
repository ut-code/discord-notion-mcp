import { MAX_GRANTS_PER_SUBMIT } from "../../grant-label";
import { formatNumber } from "../../locale";
import { MAX_QUERY_LENGTH } from "../../name-match";
import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH } from "../../paths";
import { givesPermission, isPermission, PERMISSIONS, type Permission, type SubjectType } from "../permissions/permissions";
import type { GuildInfo, RoleInfo } from "../discord/types";
import { errorMessage } from "../lib/errors";
import { isSnowflake } from "../lib/snowflake";
import { ADMIN_ONLY, type Viewer } from "./access";
import type { BadgeView } from "./badges";
import type { DashboardDeps } from "./deps";
import { formatDateJst, PERMISSION_HINTS, PERMISSION_LABELS, roleColor, roleHandle, roleSummary } from "./format";
import { formString, formStrings, type ActionResult } from "./shared";
import { grantableRoles, heldRoles, type UserSubject } from "./subjects";
import { buildGrantRows, redundancyOf, type GrantRowView, type Redundancy } from "./views";
import type { GrantRow } from "../db/schema";

export const GRANTS_PATH = `${DASHBOARD_PATH}/grants`;
/** Members listed before searching; the list is server-rendered, so it stays short enough to send. */
const MEMBER_LIST_LIMIT = 200;
const MEMBER_SEARCH_LIMIT = 50;

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
type GrantNotices = Partial<Record<Permission, string>>;

/** What the form needs to know about a subject before granting it something. */
interface GrantState {
  /** Permissions granted to exactly this subject; the form does not offer them again. */
  granted: Permission[];
  /** Permissions the subject gets some other way; granting them is allowed but adds nothing. */
  notices: GrantNotices;
}

/** A role or member the grant form offers. */
export interface SubjectOption extends GrantState {
  /** The form value: `role:<id>` or `user:<id>`. */
  key: string;
  type: SubjectType;
  id: string;
  /** The @role handle or the member's display name. */
  label: string;
  /** Members: @username and roles. */
  secondLine: string | null;
  color: string | null;
  avatarUrl: string | null;
}

export interface GrantFormView {
  /** `gives`: the other permissions it includes, so checking them together adds nothing. */
  permissions: Array<{ value: Permission; label: string; hint: string; gives: Permission[] }>;
  /** Checked when the page opens: the URL's `permission`s, else the filter tab's, else Discord 閲覧. */
  chosenPermissions: Permission[];
  /** Every grantable role, highest first. */
  roles: SubjectOption[];
  /** Members by name, the first MEMBER_LIST_LIMIT. */
  members: SubjectOption[];
  /** Members left out of `members`; searching finds them. */
  moreMembers: number;
  /** The search the page was opened with: without JavaScript the form searches by reloading. */
  query: string;
  /** Members matching `query`. */
  results: SubjectOption[];
  /** Chosen when the page opens: the URL's `subject`s (e.g. a link from the users page). */
  selected: SubjectOption[];
  /** The URL's valid `subject` keys (the first MAX_GRANTS_PER_SUBMIT), found or not: the form follows them only when they change. */
  selectedKeys: string[];
  /** Why members are missing from the list or the results. */
  membersError: string | null;
}

export interface GrantsPageData {
  filter: Permission | null;
  tabs: Array<{ label: string; count: number; href: string; active: boolean }>;
  rows: GrantTableRow[];
  form: GrantFormView;
}

function rolesText(guild: GuildInfo, user: UserSubject): string {
  if (!user.member) return m.grants_subject_non_member();
  const names = heldRoles(guild, user.member).map((role) => role.name);
  return names.length > 0 ? roleSummary(names) : m.common_no_roles();
}

/** The tooltip of a member: the Discord id, and every role when the second line names only some. */
function userTitle(guild: GuildInfo, user: UserSubject): string {
  const names = user.member ? heldRoles(guild, user.member).map((role) => role.name) : [];
  const all = names.join(", ");
  return roleSummary(names) === all ? `Discord ID ${user.id}` : `Discord ID ${user.id}\n${all}`;
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
    title: userTitle(guild, user),
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

type MemberList = { members: UserSubject[]; error: string | null };

/** The guild's members, or the error to show instead. */
async function loadMembers(
  deps: DashboardDeps,
  load: () => Promise<UserSubject[]>,
  lookup: "member_list" | "member_search",
): Promise<MemberList> {
  try {
    return { members: await load(), error: null };
  } catch (error) {
    deps.logError({ event: "admin_lookup_failed", lookup, error: errorMessage(error) });
    return { members: [], error: lookup === "member_list" ? m.grants_member_list_failed() : m.grants_member_search_failed_retry() };
  }
}

const listMembers = (deps: DashboardDeps) => loadMembers(deps, async () => (await deps.members.roster()).members, "member_list");
const searchMembers = (deps: DashboardDeps, query: string) =>
  loadMembers(deps, () => deps.subjects.search(query, MEMBER_SEARCH_LIMIT), "member_search");

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

function roleOption(guild: GuildInfo, grants: readonly GrantRow[], role: RoleInfo): SubjectOption {
  return {
    key: `role:${role.id}`,
    type: "role",
    id: role.id,
    label: roleHandle(role.name),
    secondLine: null,
    color: roleColor(role.color) ?? null,
    avatarUrl: null,
    ...grantState(guild, grants, { type: "role", id: role.id, user: null }),
  };
}

function memberOption(guild: GuildInfo, grants: readonly GrantRow[], user: UserSubject): SubjectOption {
  return {
    key: `user:${user.id}`,
    type: "user",
    id: user.id,
    label: user.displayName ?? user.id,
    secondLine: userSecondLine(guild, user),
    color: null,
    avatarUrl: user.avatarUrl,
    ...grantState(guild, grants, { type: "user", id: user.id, user }),
  };
}

type ParsedSubject = { ok: true; type: SubjectType; id: string } | { ok: false; message: string };

/** A grant subject from its type and Discord id, or why they do not name one. */
function parseSubject(type: string, id: string): ParsedSubject {
  if (!type && !id) return { ok: false, message: m.grants_choose_subject() };
  if (type !== "role" && type !== "user") return { ok: false, message: m.grants_invalid_subject_type() };
  if (!id) return { ok: false, message: m.grants_choose_subject() };
  if (!isSnowflake(id)) return { ok: false, message: m.grants_invalid_snowflake({ id }) };
  return { ok: true, type, id };
}

/** `role:<id>` or `user:<id>`, as the grant form sends it. */
function parseSubjectKey(value: string): ParsedSubject {
  const colon = value.indexOf(":");
  return colon === -1 ? parseSubject(value, "") : parseSubject(value.slice(0, colon), value.slice(colon + 1));
}

export type MemberSearchResult = { status: 200; body: { members: SubjectOption[] } } | { status: 400 | 403 | 502; body: { error: string } };

/** JSON member search behind the grant form (`GET members?q=`); admins only. */
export async function memberSearchResult(deps: DashboardDeps, rawQuery: string | null, viewer: Viewer): Promise<MemberSearchResult> {
  if (!viewer.isAdmin) return { status: 403, body: { error: ADMIN_ONLY.message ?? "" } };
  const query = rawQuery?.trim() ?? "";
  if (query.length < 1 || query.length > MAX_QUERY_LENGTH) {
    return { status: 400, body: { error: m.grants_member_query_length({ max: MAX_QUERY_LENGTH }) } };
  }
  const [guild, grants, search] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants(), searchMembers(deps, query)]);
  if (search.error) return { status: 502, body: { error: search.error } };
  return { status: 200, body: { members: search.members.map((user) => memberOption(guild, grants, user)) } };
}

/** Admins only (the route checks). Query: `filter` (tab), and the grant form state `permission`s, `subject`s, `q`. */
export async function grantsPage(deps: DashboardDeps, params: URLSearchParams): Promise<GrantsPageData> {
  const [guild, grants] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants()]);
  const filterParam = params.get("filter") ?? "";
  const filter = isPermission(filterParam) ? filterParam : null;
  const query = params.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
  const selected = uniqueSubjects(params.getAll("subject")).slice(0, MAX_GRANTS_PER_SUBMIT);
  const selectedUserIds = selected.flatMap((subject) => (subject.type === "user" ? [subject.id] : []));

  const userIds = grants.flatMap((grant) => (grant.subjectType === "user" ? [grant.subjectId] : []));
  // The owner is looked up with everyone else, so from the member list when it is available.
  const [users, roster, search] = await Promise.all([
    deps.subjects.resolveUsers([guild.ownerId, ...userIds, ...selectedUserIds]),
    listMembers(deps),
    query ? searchMembers(deps, query) : Promise.resolve({ members: [], error: null }),
  ]);
  // resolveUsers answers every id it is given; the fallback only satisfies the type.
  const owner = users.get(guild.ownerId) ?? (await deps.subjects.resolveUser(guild.ownerId));

  const allRows = buildGrantRows(guild, grants, users, owner);
  const visible = filter ? allRows.filter((row) => row.permission === filter) : allRows;
  const rows = visible.map((row) => tableRow(guild, row));

  return {
    filter,
    tabs: [null, ...PERMISSIONS].map((value) => ({
      label: value ? PERMISSION_LABELS[value] : m.grants_tab_all(),
      count: value ? allRows.filter((row) => row.permission === value).length : allRows.length,
      href: value ? `${GRANTS_PATH}?filter=${encodeURIComponent(value)}` : GRANTS_PATH,
      active: filter === value,
    })),
    rows,
    form: grantForm(guild, params, filter, { grants, query, selected, users, roster, search }),
  };
}

interface FormLookups {
  grants: readonly GrantRow[];
  query: string;
  selected: Array<{ type: SubjectType; id: string }>;
  users: ReadonlyMap<string, UserSubject>;
  roster: MemberList;
  search: MemberList;
}

function grantForm(guild: GuildInfo, params: URLSearchParams, filter: Permission | null, lookups: FormLookups): GrantFormView {
  const { grants, query, users, roster, search } = lookups;
  const permissionParams = [...new Set(params.getAll("permission").filter(isPermission))];
  const chosenPermissions = permissionParams.length > 0 ? permissionParams : [filter ?? "discord:read"];
  const roles = grantableRoles(guild).map((role) => roleOption(guild, grants, role));
  const members = roster.members.slice(0, MEMBER_LIST_LIMIT).map((user) => memberOption(guild, grants, user));
  const results = search.members.map((user) => memberOption(guild, grants, user));

  const selected = lookups.selected.flatMap((subject) => {
    if (subject.type === "role") return roles.filter((role) => role.id === subject.id);
    const user = users.get(subject.id);
    return user?.displayName ? [memberOption(guild, grants, user)] : [];
  });

  return {
    permissions: PERMISSIONS.map((value) => ({
      value,
      label: PERMISSION_LABELS[value],
      hint: PERMISSION_HINTS[value],
      gives: PERMISSIONS.filter((other) => other !== value && givesPermission(value, other)),
    })),
    chosenPermissions,
    roles,
    members,
    moreMembers: roster.members.length - members.length,
    query,
    results,
    selected,
    selectedKeys: lookups.selected.map((subject) => `${subject.type}:${subject.id}`),
    membersError: roster.error ?? search.error,
  };
}

type GrantForm = { permission: Permission; subjectType: SubjectType; subjectId: string; label: string; role?: RoleInfo };
type ParsedGrantForm = { ok: true; form: GrantForm } | { ok: false; message: string };

/** The valid subject keys among `keys`, each once. */
function uniqueSubjects(keys: string[]): Array<{ type: SubjectType; id: string }> {
  const parsed = [...new Set(keys)].map(parseSubjectKey);
  return parsed.flatMap((subject) => (subject.ok ? [{ type: subject.type, id: subject.id }] : []));
}

/** How result messages name a subject: ユーザー「name」 or ロール「name」. */
async function subjectLabel(deps: DashboardDeps, guild: GuildInfo, subject: { type: SubjectType; id: string }): Promise<string> {
  if (subject.type === "user") {
    const user = await deps.subjects.resolveUser(subject.id);
    return user.displayName ? m.grants_subject_user_named({ name: user.displayName }) : m.grants_subject_user_id({ id: subject.id });
  }
  const role = guild.roles.find((candidate) => candidate.id === subject.id);
  return role ? m.grants_subject_role_named({ name: role.name }) : m.grants_subject_role_id({ id: subject.id });
}

async function parseGrantForm(deps: DashboardDeps, body: FormData): Promise<ParsedGrantForm> {
  const permission = formString(body, "permission");
  if (!isPermission(permission)) return { ok: false, message: m.grants_unknown_permission() };
  // Delete buttons send `subjectType` and `subjectId`.
  const subject = parseSubject(formString(body, "subjectType"), formString(body, "subjectId"));
  if (!subject.ok) return { ok: false, message: subject.message };
  const { type: subjectType, id: subjectId } = subject;
  const guild = await deps.directory.fetchGuild();
  const label = await subjectLabel(deps, guild, subject);
  const role = subjectType === "role" ? guild.roles.find((candidate) => candidate.id === subjectId) : undefined;
  return { ok: true, form: { permission, subjectType, subjectId, role, label } };
}

/**
 * The grant form: every checked `permission` for every chosen `subject` (`role:<id>` or
 * `user:<id>`), up to MAX_GRANTS_PER_SUBMIT pairs; pairs already granted are counted, not repeated.
 */
export async function createGrants(deps: DashboardDeps, body: FormData, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const permissionValues = [...new Set(formStrings(body, "permission"))];
  if (permissionValues.length === 0) return { kind: "error", message: m.grants_choose_permission() };
  const permissions = permissionValues.filter(isPermission);
  if (permissions.length < permissionValues.length) return { kind: "error", message: m.grants_unknown_permission() };
  const subjects: Array<{ type: SubjectType; id: string }> = [];
  for (const key of new Set(formStrings(body, "subject"))) {
    const subject = parseSubjectKey(key);
    if (!subject.ok) return { kind: "error", message: subject.message };
    subjects.push({ type: subject.type, id: subject.id });
  }
  if (subjects.length === 0) return { kind: "error", message: m.grants_choose_subject() };
  if (subjects.length * permissions.length > MAX_GRANTS_PER_SUBMIT) {
    return { kind: "error", message: m.grants_too_many({ max: formatNumber(MAX_GRANTS_PER_SUBMIT) }) };
  }
  const guild = await deps.directory.fetchGuild();
  const unavailable = subjects.filter(
    (subject) => subject.type === "role" && !guild.roles.some((role) => role.id === subject.id && !role.managed),
  );
  if (unavailable.length > 0) {
    const names = unavailable.map(({ id }) => {
      const role = guild.roles.find((candidate) => candidate.id === id);
      return role ? roleHandle(role.name) : id;
    });
    return { kind: "error", message: m.grants_roles_unavailable({ roles: names.join("、") }) };
  }

  const by = actor.discordUserId;
  const inputs = subjects.flatMap((subject) =>
    permissions.map((permission) => ({ permission, subjectType: subject.type, subjectId: subject.id, createdBy: by })),
  );
  const added = await deps.grants.createGrants(inputs);
  for (const grant of added) deps.log({ event: "grant_added", ...grant, by });
  const created = added.length;
  const [onlySubject] = subjects;
  const [onlyPermission] = permissions;
  if (onlySubject && onlyPermission && subjects.length === 1 && permissions.length === 1) {
    const label = await subjectLabel(deps, guild, onlySubject);
    const permission = PERMISSION_LABELS[onlyPermission];
    return created
      ? { kind: "ok", message: m.grants_granted({ subject: label, permission }) }
      : { kind: "warn", message: m.grants_already_granted({ subject: label, permission }) };
  }
  const skipped = subjects.length * permissions.length - created;
  if (created === 0) return { kind: "warn", message: m.grants_all_already_granted() };
  return {
    kind: "ok",
    message: skipped
      ? m.grants_granted_count_skipped({ count: formatNumber(created), skipped: formatNumber(skipped) })
      : m.grants_granted_count({ count: formatNumber(created) }),
  };
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
