const SIGNATURE_PARAM = "sig";
const SIGNED_NAMES_PARAM = "ba_param";

/**
 * Extracts the signed authorization query that Better Auth appended when it
 * redirected to the login/consent page. Mirrors `buildSignedOAuthQuery` from
 * `@better-auth/oauth-provider/client` so the pages need no client bundle.
 */
export function extractSignedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has(SIGNATURE_PARAM)) return undefined;
  const signedNames = new Set(params.getAll(SIGNED_NAMES_PARAM));
  if (signedNames.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === SIGNATURE_PARAM || key === SIGNED_NAMES_PARAM || signedNames.has(key)) signed.append(key, value);
  }
  return signed.toString();
}
