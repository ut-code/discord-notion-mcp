import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { oauthClient } from "../db/better-auth-tables";

/** Registered OAuth client names, readable before sign-in (Better Auth's lookup endpoint needs a session). */
export class OAuthClientNames {
  constructor(private readonly db: AppDatabase) {}

  async nameFor(clientId: string): Promise<string | null> {
    const [row] = await this.db.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
    return row?.name?.trim() || null;
  }
}
