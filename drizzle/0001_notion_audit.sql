CREATE TABLE `notion_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`discord_user_id` text NOT NULL,
	`discord_display_name` text NOT NULL,
	`discord_username` text,
	`operation` text NOT NULL,
	`target_page_id` text,
	`target_url` text,
	`request` text NOT NULL,
	`snapshot` text,
	`result` text,
	`status` text NOT NULL,
	`error` text,
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
CREATE INDEX `notion_audit_discord_user_idx` ON `notion_audit` (`discord_user_id`);