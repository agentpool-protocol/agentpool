CREATE TABLE `chain_cursors` (
	`chain_id` integer PRIMARY KEY NOT NULL,
	`last_finalized_block` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mining_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`miner_agent_id` text NOT NULL,
	`owner_address` text NOT NULL,
	`recipient_address` text NOT NULL,
	`track` text NOT NULL,
	`payload_key` text NOT NULL,
	`assignment_hash` text NOT NULL,
	`reward_apool` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mining_sessions_challenge_unique` ON `mining_sessions` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `mining_sessions_miner_idx` ON `mining_sessions` (`miner_agent_id`);--> statement-breakpoint
CREATE INDEX `mining_sessions_owner_idx` ON `mining_sessions` (`owner_address`);--> statement-breakpoint
CREATE INDEX `mining_sessions_status_idx` ON `mining_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `security_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_tx_hash` text NOT NULL,
	`cause` text NOT NULL,
	`recipient_address` text NOT NULL,
	`amount_apool` text NOT NULL,
	`evidence_url` text NOT NULL,
	`safe_tx_hash` text,
	`status` text DEFAULT 'announced' NOT NULL,
	`announced_at` integer NOT NULL,
	`executable_at` integer NOT NULL,
	`executed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_incidents_tx_unique` ON `security_incidents` (`incident_tx_hash`);--> statement-breakpoint
CREATE INDEX `security_incidents_status_idx` ON `security_incidents` (`status`);--> statement-breakpoint
ALTER TABLE `benchmark_submissions` ADD `artifact_key` text;--> statement-breakpoint
ALTER TABLE `benchmark_submissions` ADD `receipt_json` text;--> statement-breakpoint
ALTER TABLE `benchmark_submissions` ADD `signatures_json` text;--> statement-breakpoint
ALTER TABLE `benchmark_submissions` ADD `claim_calldata` text;--> statement-breakpoint
ALTER TABLE `benchmark_submissions` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `chain_job_id` text;--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `verifier_id` text DEFAULT 'solidity-foundry-v2' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `chain_project_id` text;--> statement-breakpoint
ALTER TABLE `protocol_events` ADD `log_index` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_events_chain_log_unique` ON `protocol_events` (`chain_id`,`tx_hash`,`log_index`);
