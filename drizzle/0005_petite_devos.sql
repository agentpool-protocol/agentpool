CREATE TABLE `v41_chain_assignments` (
	`assignment_id` text PRIMARY KEY NOT NULL,
	`chain_id` integer DEFAULT 84532 NOT NULL,
	`vault_address` text NOT NULL,
	`open_tx_hash` text NOT NULL,
	`accept_tx_hash` text,
	`deliver_tx_hash` text,
	`settle_tx_hash` text,
	`expire_tx_hash` text,
	`last_block` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_chain_assignments_open_tx_unique` ON `v41_chain_assignments` (`open_tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `v41_chain_assignments_accept_tx_unique` ON `v41_chain_assignments` (`accept_tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `v41_chain_assignments_deliver_tx_unique` ON `v41_chain_assignments` (`deliver_tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `v41_chain_assignments_settle_tx_unique` ON `v41_chain_assignments` (`settle_tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `v41_chain_assignments_expire_tx_unique` ON `v41_chain_assignments` (`expire_tx_hash`);--> statement-breakpoint
CREATE INDEX `v41_chain_assignments_state_idx` ON `v41_chain_assignments` (`state`);--> statement-breakpoint
CREATE INDEX `v41_chain_assignments_block_idx` ON `v41_chain_assignments` (`last_block`);