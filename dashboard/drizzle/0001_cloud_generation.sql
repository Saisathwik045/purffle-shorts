CREATE TABLE `operation_budgets` (
	`period` text NOT NULL,
	`kind` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_budgets_period_kind_unique` ON `operation_budgets` (`period`,`kind`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `storage_reserved` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatch_status` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatch_error` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `runner_url` text;