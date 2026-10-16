import { isOneOf } from "../../one-of";

export const PERMISSIONS = ["discord:read", "notion:read", "notion:write", "admin"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SUBJECT_TYPES = ["role", "user"] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** Permissions that come with another: editing Notion means copying text from the page, so writing includes reading. */
const INCLUDES: Partial<Record<Permission, readonly Permission[]>> = { "notion:write": ["notion:read"] };

/** Whether holding `held` gives `wanted`; admin gives every permission. */
export function givesPermission(held: Permission, wanted: Permission): boolean {
  return held === wanted || held === "admin" || (INCLUDES[held]?.includes(wanted) ?? false);
}

/** The permissions `granted` gives, with the ones they include. */
export function withIncluded(granted: Iterable<Permission>): Set<Permission> {
  const all = new Set(granted);
  for (const permission of [...all]) for (const included of INCLUDES[permission] ?? []) all.add(included);
  return all;
}

export function isPermission(value: string): value is Permission {
  return isOneOf(PERMISSIONS, value);
}
