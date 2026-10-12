import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/*
 * Partial views of tables that Better Auth owns and migrates, so they are
 * intentionally excluded from drizzle-kit (see drizzle.config.ts). Dates are
 * stored by Better Auth as ISO 8601 strings. Only token revocation and the
 * unused-client cleanup delete rows through these views; everything else only
 * reads them.
 */

export const authUser = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("createdAt").notNull(),
});

export const authAccount = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const authSession = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  createdAt: text("createdAt").notNull(),
});

/** Deleting a client cascades to its oauthClientResource rows (foreign keys are on). */
export const oauthClient = sqliteTable("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  createdAt: text("createdAt"),
});

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
});

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId").notNull(),
});

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId"),
  refreshId: text("refreshId"),
});
