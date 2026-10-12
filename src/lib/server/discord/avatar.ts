import { CDN, type ImageURLOptions } from "@discordjs/rest";

const cdn = new CDN();
/** Static PNG at twice the largest rendered avatar (32px) for high-density screens. */
const IMAGE: ImageURLOptions = { extension: "png", size: 64, forceStatic: true };
/** Hashes go into the URL path, so anything else is treated as "no avatar". */
const HASH = /^(a_)?[0-9a-f]{16,64}$/i;

function validHash(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && HASH.test(hash);
}

/** Global avatar of a user; null when the user has the default avatar. */
export function userAvatarUrl(userId: string, hash: string | null | undefined): string | null {
  return validHash(hash) ? cdn.avatar(userId, hash, IMAGE) : null;
}

/** Server-specific avatar when set, else the user's global avatar. */
export function memberAvatarUrl(
  guildId: string,
  userId: string,
  memberHash: string | null | undefined,
  userHash: string | null | undefined,
): string | null {
  if (validHash(memberHash)) return cdn.guildMemberAvatar(guildId, userId, memberHash, IMAGE);
  return userAvatarUrl(userId, userHash);
}
