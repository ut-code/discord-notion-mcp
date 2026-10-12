CREATE TABLE `token_revocation` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL
);
