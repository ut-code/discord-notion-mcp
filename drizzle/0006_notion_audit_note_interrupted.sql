DROP INDEX `notion_audit_one_revert_idx`;--> statement-breakpoint
ALTER TABLE `notion_audit` ADD `note` text;--> statement-breakpoint
-- Interrupted writes were failed rows with a marker error.
UPDATE `notion_audit` SET `status` = 'interrupted', `error` = NULL WHERE `status` = 'failed' AND `error` = 'interrupted (server restarted)';--> statement-breakpoint
-- Successful rows kept their warning or revert note in `error`: JSON in newer rows, English text in older ones.
UPDATE `notion_audit` SET `note` = CASE WHEN json_valid(`error`) THEN `error` ELSE json_object('kind', 'legacy', 'text', `error`) END, `error` = NULL WHERE `status` = 'ok' AND `error` IS NOT NULL;--> statement-breakpoint
UPDATE `notion_audit` SET `revert_note` = json_object('kind', 'legacy', 'text', `revert_note`) WHERE `revert_note` IS NOT NULL AND NOT json_valid(`revert_note`);--> statement-breakpoint
CREATE UNIQUE INDEX `notion_audit_one_revert_idx` ON `notion_audit` (`revert_of_audit_id`) WHERE "notion_audit"."status" in ('pending', 'ok');