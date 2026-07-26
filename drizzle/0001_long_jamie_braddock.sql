CREATE TABLE `benchmark_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`track` text NOT NULL,
	`league` text NOT NULL,
	`difficulty` text NOT NULL,
	`policy_version` integer NOT NULL,
	`commitment_hash` text NOT NULL,
	`base_reward_apool` text NOT NULL,
	`generator_agent_id` text NOT NULL,
	`status` text DEFAULT 'committed' NOT NULL,
	`reveal_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `benchmark_challenges_track_idx` ON `benchmark_challenges` (`track`);--> statement-breakpoint
CREATE INDEX `benchmark_challenges_status_idx` ON `benchmark_challenges` (`status`);--> statement-breakpoint
CREATE INDEX `benchmark_challenges_created_idx` ON `benchmark_challenges` (`created_at`);--> statement-breakpoint
CREATE TABLE `benchmark_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`miner_agent_id` text NOT NULL,
	`recipient_address` text NOT NULL,
	`submission_hash` text NOT NULL,
	`accuracy_bps` integer,
	`efficiency_bps` integer,
	`reward_apool` text,
	`receipt_digest` text,
	`claim_tx_hash` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_submissions_challenge_miner_unique` ON `benchmark_submissions` (`challenge_id`,`miner_agent_id`);--> statement-breakpoint
CREATE INDEX `benchmark_submissions_miner_idx` ON `benchmark_submissions` (`miner_agent_id`);--> statement-breakpoint
CREATE INDEX `benchmark_submissions_status_idx` ON `benchmark_submissions` (`status`);--> statement-breakpoint
CREATE TABLE `project_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worker_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`strategy` text NOT NULL,
	`price_apool` text NOT NULL,
	`validation_fee_apool` text NOT NULL,
	`dependencies_json` text NOT NULL,
	`requirements_hash` text NOT NULL,
	`delivery_hash` text,
	`state` text DEFAULT 'PLANNED' NOT NULL,
	`deadline_at` integer NOT NULL,
	`tx_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_tasks_project_idx` ON `project_tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_tasks_worker_idx` ON `project_tasks` (`worker_agent_id`);--> statement-breakpoint
CREATE INDEX `project_tasks_state_idx` ON `project_tasks` (`state`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`buyer_agent_id` text NOT NULL,
	`coordinator_agent_id` text NOT NULL,
	`brief` text NOT NULL,
	`brief_hash` text NOT NULL,
	`plan_root` text,
	`max_worker_budget_apool` text NOT NULL,
	`validation_reserve_apool` text NOT NULL,
	`min_agents` integer NOT NULL,
	`max_parallel` integer NOT NULL,
	`max_tasks` integer NOT NULL,
	`state` text DEFAULT 'PENDING_CHAIN' NOT NULL,
	`deadline_at` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_buyer_idx` ON `projects` (`buyer_agent_id`);--> statement-breakpoint
CREATE INDEX `projects_coordinator_idx` ON `projects` (`coordinator_agent_id`);--> statement-breakpoint
CREATE INDEX `projects_state_idx` ON `projects` (`state`);