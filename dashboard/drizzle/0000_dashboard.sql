CREATE TABLE IF NOT EXISTS `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`owner` text NOT NULL,
	`attempt` integer NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`duration` real NOT NULL,
	`video_key` text,
	`subtitle_key` text,
	`review_status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `clips_job_id_attempt_position_unique` ON `clips` (`job_id`,`attempt`,`position`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`state` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`attempt` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source_url` text NOT NULL,
	`source_kind` text NOT NULL,
	`title` text NOT NULL,
	`thumbnail` text,
	`options` text NOT NULL,
	`authorization` text,
	`state` text NOT NULL,
	`error` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`lease_id` text,
	`lease_expires` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `jobs_owner_updated` ON `jobs` (`owner`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `jobs_queue` ON `jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `jobs_owner_fingerprint_unique` ON `jobs` (`owner`,`fingerprint`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_states` (
	`hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`clip_id` text NOT NULL,
	`owner` text NOT NULL,
	`state` text NOT NULL,
	`youtube_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`published_at` text,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`preferences` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `youtube_accounts` (
	`owner` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`encrypted_tokens` text NOT NULL,
	`connected_at` text NOT NULL
);
