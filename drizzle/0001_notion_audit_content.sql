CREATE TABLE `notion_audit_content` (
	`audit_id` integer PRIMARY KEY NOT NULL,
	`before` blob NOT NULL,
	`after` blob,
	FOREIGN KEY (`audit_id`) REFERENCES `notion_audit`(`id`) ON UPDATE no action ON DELETE no action
);
