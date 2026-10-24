import { calculateUserDefaultAvatarIndex, CDN, type ImageURLOptions } from "@discordjs/rest";
import type { APIUser } from "discord-api-types/v10";

const cdn = new CDN();
/** Static PNG at twice the largest rendered avatar (32px) for high-density screens. */
const IMAGE: ImageURLOptions = { extension: "png", size: 64, forceStatic: true };
/** Hashes go into the URL path, so anything else is treated as "no avatar". */
const HASH = /^(a_)?[0-9a-f]{16,64}$/i;
/**
 * Default avatars of users still on the legacy username system (a discriminator other than "0",
 * e.g. some bots) are picked by `discriminator % 5`; everyone else's by their id (Discord docs,
 * Reference › Image Formatting › CDN Endpoints, note on the default user avatar).
 */
const LEGACY_DEFAULT_AVATARS = 5;

type AvatarUser = Pick<APIUser, "id" | "avatar"> & { discriminator?: string };

function validHash(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && HASH.test(hash);
}

/** Server icon at twice the largest rendered logo (44px); null when the server has none. */
export function guildIconUrl(guildId: string, hash: string | null | undefined): string | null {
  return validHash(hash) ? cdn.icon(guildId, hash, { ...IMAGE, size: 128 }) : null;
}

/** The avatar Discord shows for a user who has not set one. */
function defaultAvatarUrl(user: AvatarUser): string {
  const discriminator = Number(user.discriminator ?? "0");
  const legacy = Number.isInteger(discriminator) && discriminator > 0;
  return cdn.defaultAvatar(legacy ? discriminator % LEGACY_DEFAULT_AVATARS : calculateUserDefaultAvatarIndex(user.id));
}

/** Global avatar of a user, or Discord's default avatar when none is set. */
export function userAvatarUrl(user: AvatarUser): string {
  return validHash(user.avatar) ? cdn.avatar(user.id, user.avatar, IMAGE) : defaultAvatarUrl(user);
}

/** Server-specific avatar when set, else the user's global avatar (or the default one). */
export function memberAvatarUrl(guildId: string, user: AvatarUser, memberHash: string | null | undefined): string {
  if (validHash(memberHash)) return cdn.guildMemberAvatar(guildId, user.id, memberHash, IMAGE);
  return userAvatarUrl(user);
}
