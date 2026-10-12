import { isAPIError } from "better-auth/api";
import type { Auth } from "./auth";

/** Registered name of an OAuth client; null when it is unnamed, unknown or disabled (the provider answers 404). */
async function clientName(lookup: () => Promise<{ client_name?: string }>): Promise<string | null> {
  try {
    return (await lookup()).client_name?.trim() || null;
  } catch (error) {
    if (isAPIError(error)) return null;
    throw error;
  }
}

/** For the sign-in page: the signed authorization query stands in for the missing session. */
export function clientNameBeforeSignIn(auth: Auth, clientId: string, oauthQuery: string): Promise<string | null> {
  return clientName(() => auth.api.getOAuthClientPublicPrelogin({ body: { client_id: clientId, oauth_query: oauthQuery } }));
}

/** For pages behind a browser session, such as the consent page. */
export function clientNameForSession(auth: Auth, clientId: string, headers: Headers): Promise<string | null> {
  return clientName(() => auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers }));
}
