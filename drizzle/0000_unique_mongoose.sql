CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_address` text NOT NULL,
	`delegate_address` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`encryption_public_key` text NOT NULL,
	`endpoint` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`completed_jobs` integer DEFAULT 0 NOT NULL,
	`disputed_jobs` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_owner_address_unique` ON `agents` (`owner_address`);--> statement-breakpoint
CREATE INDEX `agents_score_idx` ON `agents` (`score`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE TABLE `api_nonces` (
	`address` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_nonces_expires_idx` ON `api_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_agent_id` text NOT NULL,
	`job_id` text,
	`content_hash` text NOT NULL,
	`ciphertext_hash` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`encryption_suite` text DEFAULT 'HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305' NOT NULL,
	`key_envelope` text,
	`status` text DEFAULT 'sealed' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_ciphertext_hash_unique` ON `artifacts` (`ciphertext_hash`);--> statement-breakpoint
CREATE INDEX `artifacts_job_idx` ON `artifacts` (`job_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`evaluator_agent_id` text NOT NULL,
	`phase` text NOT NULL,
	`decision` text,
	`evidence_hash` text,
	`commitment` text,
	`bond_apool` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluations_job_idx` ON `evaluations` (`job_id`);--> statement-breakpoint
CREATE INDEX `evaluations_evaluator_idx` ON `evaluations` (`evaluator_agent_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`actor_address` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`status_code` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text,
	`buyer_agent_id` text NOT NULL,
	`seller_agent_id` text NOT NULL,
	`price_apool` text NOT NULL,
	`evaluation_budget_apool` text NOT NULL,
	`seller_bond_apool` text NOT NULL,
	`state` text NOT NULL,
	`requirements_hash` text NOT NULL,
	`delivery_hash` text,
	`artifact_key` text,
	`verifier_id` text NOT NULL,
	`outcome` text,
	`deadline_at` integer NOT NULL,
	`challenge_deadline_at` integer,
	`tx_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_buyer_idx` ON `jobs` (`buyer_agent_id`);--> statement-breakpoint
CREATE INDEX `jobs_seller_idx` ON `jobs` (`seller_agent_id`);--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`asset_type` text NOT NULL,
	`price_mode` text NOT NULL,
	`price_apool` text NOT NULL,
	`license_type` text NOT NULL,
	`verifier_id` text NOT NULL,
	`content_hash` text,
	`resale_allowed` integer DEFAULT false NOT NULL,
	`mining_eligible` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `listings_seller_idx` ON `listings` (`seller_agent_id`);--> statement-breakpoint
CREATE INDEX `listings_asset_type_idx` ON `listings` (`asset_type`);--> statement-breakpoint
CREATE INDEX `listings_status_idx` ON `listings` (`status`);--> statement-breakpoint
CREATE TABLE `mining_epochs` (
	`epoch` integer PRIMARY KEY NOT NULL,
	`budget_apool` text NOT NULL,
	`eligible_work_apool` text DEFAULT '0' NOT NULL,
	`contribution_score` real DEFAULT 0 NOT NULL,
	`reward_root` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`claimable_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mining_epochs_status_idx` ON `mining_epochs` (`status`);--> statement-breakpoint
CREATE TABLE `protocol_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_address` text,
	`payload_json` text NOT NULL,
	`chain_id` integer DEFAULT 84532 NOT NULL,
	`block_number` integer,
	`tx_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `protocol_events_type_idx` ON `protocol_events` (`type`);--> statement-breakpoint
CREATE INDEX `protocol_events_entity_idx` ON `protocol_events` (`entity_id`);--> statement-breakpoint
CREATE INDEX `protocol_events_created_idx` ON `protocol_events` (`created_at`);