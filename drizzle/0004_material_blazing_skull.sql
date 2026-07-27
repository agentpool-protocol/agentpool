CREATE TABLE `v41_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`author_address` text NOT NULL,
	`content_hash` text NOT NULL,
	`provenance_hash` text NOT NULL,
	`license_hash` text NOT NULL,
	`release_id` text NOT NULL,
	`capability` text NOT NULL,
	`proof_hash` text NOT NULL,
	`reuse_price_apool` text DEFAULT '0' NOT NULL,
	`state` text DEFAULT 'PROVEN' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_artifacts_content_unique` ON `v41_artifacts` (`content_hash`);--> statement-breakpoint
CREATE INDEX `v41_artifacts_capability_idx` ON `v41_artifacts` (`capability`);--> statement-breakpoint
CREATE INDEX `v41_artifacts_release_idx` ON `v41_artifacts` (`release_id`);--> statement-breakpoint
CREATE TABLE `v41_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`worker_address` text NOT NULL,
	`profile_id` text NOT NULL,
	`market` text NOT NULL,
	`funding_source` text NOT NULL,
	`release_id` text NOT NULL,
	`policy_hash` text NOT NULL,
	`awarded_apool` text NOT NULL,
	`reserved_apool` text NOT NULL,
	`state` text DEFAULT 'AWARDED' NOT NULL,
	`delivery_hash` text,
	`proof_commitment` text,
	`proof_hash` text,
	`tx_hash` text,
	`deadline_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_assignments_opportunity_unique` ON `v41_assignments` (`opportunity_id`);--> statement-breakpoint
CREATE INDEX `v41_assignments_worker_idx` ON `v41_assignments` (`worker_address`);--> statement-breakpoint
CREATE INDEX `v41_assignments_state_idx` ON `v41_assignments` (`state`);--> statement-breakpoint
CREATE TABLE `v41_bids` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`bidder_address` text NOT NULL,
	`profile_id` text NOT NULL,
	`commitment` text NOT NULL,
	`price_apool` text,
	`capacity_units` integer,
	`reveal_salt_hash` text,
	`state` text DEFAULT 'COMMITTED' NOT NULL,
	`created_at` integer NOT NULL,
	`revealed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_bids_opportunity_bidder_unique` ON `v41_bids` (`opportunity_id`,`bidder_address`);--> statement-breakpoint
CREATE INDEX `v41_bids_state_idx` ON `v41_bids` (`state`);--> statement-breakpoint
CREATE TABLE `v41_capability_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`owner_address` text NOT NULL,
	`profile_id` text NOT NULL,
	`track` text NOT NULL,
	`challenge_commitment` text NOT NULL,
	`submission_hash` text,
	`score_bps` integer,
	`latency_ms` integer,
	`reward_apool` text NOT NULL,
	`state` text DEFAULT 'ACTIVE' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_capability_active_profile_track_unique` ON `v41_capability_sessions` (`profile_id`,`track`,`challenge_commitment`);--> statement-breakpoint
CREATE INDEX `v41_capability_owner_idx` ON `v41_capability_sessions` (`owner_address`);--> statement-breakpoint
CREATE INDEX `v41_capability_state_idx` ON `v41_capability_sessions` (`state`);--> statement-breakpoint
CREATE TABLE `v41_epoch_accounting` (
	`epoch` integer PRIMARY KEY NOT NULL,
	`allowance_apool` text NOT NULL,
	`capability_reserved_apool` text DEFAULT '0' NOT NULL,
	`capability_minted_apool` text DEFAULT '0' NOT NULL,
	`basic_reserved_apool` text DEFAULT '0' NOT NULL,
	`basic_minted_apool` text DEFAULT '0' NOT NULL,
	`system_reserved_apool` text DEFAULT '0' NOT NULL,
	`system_minted_apool` text DEFAULT '0' NOT NULL,
	`validation_reserved_apool` text DEFAULT '0' NOT NULL,
	`validation_minted_apool` text DEFAULT '0' NOT NULL,
	`experimental_minted_apool` text DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `v41_execution_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`owner_address` text NOT NULL,
	`capability` text NOT NULL,
	`runtime_hash` text NOT NULL,
	`model_hash` text NOT NULL,
	`conservative_success_bps` integer DEFAULT 0 NOT NULL,
	`p50_latency_ms` integer DEFAULT 0 NOT NULL,
	`p95_latency_ms` integer DEFAULT 0 NOT NULL,
	`reproducible_results` integer DEFAULT 0 NOT NULL,
	`external_results` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_profiles_agent_runtime_track_unique` ON `v41_execution_profiles` (`agent_id`,`runtime_hash`,`capability`);--> statement-breakpoint
CREATE INDEX `v41_profiles_capability_idx` ON `v41_execution_profiles` (`capability`);--> statement-breakpoint
CREATE INDEX `v41_profiles_owner_idx` ON `v41_execution_profiles` (`owner_address`);--> statement-breakpoint
CREATE TABLE `v41_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`funding_source` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`capability` text NOT NULL,
	`specification_hash` text NOT NULL,
	`release_id` text NOT NULL,
	`proof_policy` text NOT NULL,
	`max_budget_apool` text NOT NULL,
	`estimated_cost_apool` text NOT NULL,
	`risk_bps` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `v41_opportunities_market_idx` ON `v41_opportunities` (`market`);--> statement-breakpoint
CREATE INDEX `v41_opportunities_state_idx` ON `v41_opportunities` (`state`);--> statement-breakpoint
CREATE INDEX `v41_opportunities_deadline_idx` ON `v41_opportunities` (`deadline_at`);--> statement-breakpoint
CREATE TABLE `v41_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`verifier_address` text NOT NULL,
	`commitment` text NOT NULL,
	`decision` text,
	`evidence_hash` text,
	`salt_hash` text,
	`state` text DEFAULT 'COMMITTED' NOT NULL,
	`created_at` integer NOT NULL,
	`revealed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_proofs_assignment_verifier_unique` ON `v41_proofs` (`assignment_id`,`verifier_address`);--> statement-breakpoint
CREATE INDEX `v41_proofs_state_idx` ON `v41_proofs` (`state`);--> statement-breakpoint
CREATE TABLE `v41_system_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_address` text NOT NULL,
	`issue_commitment` text NOT NULL,
	`evidence_hash` text,
	`reproduction_hash` text,
	`affected_release_id` text,
	`max_budget_apool` text,
	`state` text DEFAULT 'COMMITTED' NOT NULL,
	`created_at` integer NOT NULL,
	`revealed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v41_system_issue_commitment_unique` ON `v41_system_issues` (`issue_commitment`);--> statement-breakpoint
CREATE INDEX `v41_system_issue_state_idx` ON `v41_system_issues` (`state`);