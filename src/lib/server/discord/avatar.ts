const CDN = "https://cdn.discordapp.com";
/** Twice the largest rendered avatar (32px) for high-density screens. */
const SIZE = 64;
const HASH = /^(a_)?[0-9a-f]{16,64}$/i;

function validHash(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && HASH.test(hash);
}

/** Global avatar of a user; null when the user has the default avatar. */
export function userAvatarUrl(userId: string, hash: string | null | undefined): string | null {
  return validHash(hash) ? `${CDN}/avatars/${userId}/${hash}.png?size=${SIZE}` : null;
}

/** Server-specific avatar when set, else the user's global avatar. */
export function memberAvatarUrl(
  guildId: string,
  userId: string,
  memberHash: string | null | undefined,
  userHash: string | null | undefined,
): string | null {
  if (validHash(memberHash)) return `${CDN}/guilds/${guildId}/users/${userId}/avatars/${memberHash}.png?size=${SIZE}`;
  return userAvatarUrl(userId, userHash);
}
