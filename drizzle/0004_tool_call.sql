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