CREATE TABLE `v43_gas_grant_daily_budgets` (
	`day_bucket` integer PRIMARY KEY NOT NULL,
	`grant_count` integer DEFAULT 0 NOT NULL,
	`amount_wei` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `v43_gas_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`request_event_id` text NOT NULL,
	`recipient_address` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`amount_wei` integer NOT NULL,
	`balance_before_wei` integer NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text,
	`block_number` integer,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v43_gas_grants_request_event_unique` ON `v43_gas_grants` (`request_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v43_gas_grants_recipient_day_unique` ON `v43_gas_grants` (`recipient_address`,`day_bucket`);--> statement-breakpoint
CREATE UNIQUE INDEX `v43_gas_grants_tx_hash_unique` ON `v43_gas_grants` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `v43_gas_grants_status_idx` ON `v43_gas_grants` (`status`);--> statement-breakpoint
CREATE INDEX `v43_gas_grants_created_idx` ON `v43_gas_grants` (`created_at`);