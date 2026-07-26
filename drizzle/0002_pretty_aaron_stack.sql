CREATE UNIQUE INDEX `jobs_tx_hash_unique` ON `jobs` (`tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_tx_hash_unique` ON `projects` (`tx_hash`);