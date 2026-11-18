ALTER TABLE `worker_heartbeats` ADD `credential_hash` text;--> statement-breakpoint
ALTER TABLE `worker_heartbeats` ADD `storage_verified_at` text;--> statement-breakpoint
ALTER TABLE `worker_heartbeats` ADD `last_check_error` text;