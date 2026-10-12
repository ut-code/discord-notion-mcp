CREATE TABLE `grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`permission` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_permission_subject_unique` ON `grants` (`permission`,`subject_type`,`subject_id`);