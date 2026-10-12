export interface DisplayNameParts {
  nick?: string | null;
  globalName?: string | null;
  username: string;
}

/** Server nickname, then global display name, then username. */
export function displayName(parts: DisplayNameParts): string {
  return parts.nick || parts.globalName || parts.username;
}
