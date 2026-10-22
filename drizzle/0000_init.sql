CREATE TABLE `grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`permission` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_permission_subject_unique` ON `grants` (`permission`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `notion_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`discord_user_id` text NOT NULL,
	`discord_display_name` text NOT NULL,
	`discord_username` text,
	`operation` text NOT NULL,
	`target_page_id` text,
	`target_url` text,
	`target_title` text NOT NULL,
	`request` text NOT NULL,
	`snapshot` text,
	`result` text,
	`status` text NOT NULL,
	`error` text,
	`note` text,
	`comment_error` text,
	`result_last_edited_time` text,
	`reverted_at` integer,
	`reverted_by` text,
	`revert_audit_id` integer,
	`revert_note` text,
	`revert_of_audit_id` integer
);
--> statement-breakpoint
CREATE INDEX `notion_audit_created_at_idx` ON `notion_audit` (`created_at`);--> statement-breakpoint
CREATE INDEX `notion_audit_discord_user_idx` ON `notion_audit` (`discord_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notion_audit_one_revert_idx` ON `notion_audit` (`revert_of_audit_id`) WHERE "notion_audit"."status" in ('pending', 'ok');--> statement-breakpoint
CREATE TABLE `notion_audit_content` (
	`audit_id` integer PRIMARY KEY NOT NULL,
	`before` blob NOT NULL,
	`after` blob,
	FOREIGN KEY (`audit_id`) REFERENCES `notion_audit`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `token_revocation` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_call` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`discord_user_id` text NOT NULL,
	`tool` text NOT NULL,
	`ok` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`error_kind` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `tool_call_created_at_idx` ON `tool_call` (`created_at`);--> statement-breakpoint
CREATE INDEX `tool_call_user_created_at_idx` ON `tool_call` (`discord_user_id`,`created_at`);