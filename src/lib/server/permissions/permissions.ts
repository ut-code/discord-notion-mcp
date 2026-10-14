import { isOneOf } from "../../one-of";

export const PERMISSIONS = ["discord:read", "notion:read", "notion:write", "admin"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SUBJECT_TYPES = ["role", "user"] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

export function isPermission(value: string): value is Permission {
  return isOneOf(PERMISSIONS, value);
}
