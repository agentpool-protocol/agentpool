import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    delegateAddress: text("delegate_address").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    capabilitiesJson: text("capabilities_json").notNull(),
    encryptionPublicKey: text("encryption_public_key").notNull(),
    endpoint: text("endpoint").notNull(),
    score: real("score").notNull().default(0),
    completedJobs: integer("completed_jobs").notNull().default(0),
    disputedJobs: integer("disputed_jobs").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agents_owner_address_unique").on(table.ownerAddress),
    index("agents_score_idx").on(table.score),
    index("agents_status_idx").on(table.status),
  ],
);

export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    sellerAgentId: text("seller_agent_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    assetType: text("asset_type").notNull(),
    priceMode: text("price_mode").notNull(),
    priceApool: text("price_apool").notNull(),
    licenseType: text("license_type").notNull(),
    verifierId: text("verifier_id").notNull(),
    contentHash: text("content_hash"),
    resaleAllowed: integer("resale_allowed", { mode: "boolean" }).notNull().default(false),
    miningEligible: integer("mining_eligible", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("listings_seller_idx").on(table.sellerAgentId),
    index("listings_asset_type_idx").on(table.assetType),
    index("listings_status_idx").on(table.status),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id"),
    buyerAgentId: text("buyer_agent_id").notNull(),
    sellerAgentId: text("seller_agent_id").notNull(),
    priceApool: text("price_apool").notNull(),
    // Kept on the legacy physical column name so the public D1 can migrate in place.
    validationFeeApool: text("evaluation_budget_apool").notNull(),
    sellerBondApool: text("seller_bond_apool").notNull(),
    state: text("state").notNull(),
    requirementsHash: text("requirements_hash").notNull(),
    deliveryHash: text("delivery_hash"),
    artifactKey: text("artifact_key"),
    verifierId: text("verifier_id").notNull(),
    outcome: text("outcome"),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    challengeDeadlineAt: integer("challenge_deadline_at", { mode: "timestamp_ms" }),
    txHash: text("tx_hash"),
    chainJobId: text("chain_job_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("jobs_buyer_idx").on(table.buyerAgentId),
    index("jobs_seller_idx").on(table.sellerAgentId),
    index("jobs_state_idx").on(table.state),
    index("jobs_created_idx").on(table.createdAt),
    uniqueIndex("jobs_tx_hash_unique").on(table.txHash),
  ],
);

export const benchmarkChallenges = sqliteTable(
  "benchmark_challenges",
  {
    id: text("id").primaryKey(),
    track: text("track").notNull(),
    league: text("league").notNull(),
    difficulty: text("difficulty").notNull(),
    policyVersion: integer("policy_version").notNull(),
    commitmentHash: text("commitment_hash").notNull(),
    baseRewardApool: text("base_reward_apool").notNull(),
    generatorAgentId: text("generator_agent_id").notNull(),
    status: text("status").notNull().default("committed"),
    revealAt: integer("reveal_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("benchmark_challenges_track_idx").on(table.track),
    index("benchmark_challenges_status_idx").on(table.status),
    index("benchmark_challenges_created_idx").on(table.createdAt),
  ],
);

export const benchmarkSubmissions = sqliteTable(
  "benchmark_submissions",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id").notNull(),
    minerAgentId: text("miner_agent_id").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    submissionHash: text("submission_hash").notNull(),
    accuracyBps: integer("accuracy_bps"),
    efficiencyBps: integer("efficiency_bps"),
    rewardApool: text("reward_apool"),
    receiptDigest: text("receipt_digest"),
    artifactKey: text("artifact_key"),
    receiptJson: text("receipt_json"),
    signaturesJson: text("signatures_json"),
    claimCalldata: text("claim_calldata"),
    claimTxHash: text("claim_tx_hash"),
    status: text("status").notNull().default("submitted"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("benchmark_submissions_challenge_miner_unique").on(
      table.challengeId,
      table.minerAgentId,
    ),
    index("benchmark_submissions_miner_idx").on(table.minerAgentId),
    index("benchmark_submissions_status_idx").on(table.status),
  ],
);

export const miningSessions = sqliteTable(
  "mining_sessions",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id").notNull(),
    minerAgentId: text("miner_agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    track: text("track").notNull(),
    payloadKey: text("payload_key").notNull(),
    assignmentHash: text("assignment_hash").notNull(),
    rewardApool: text("reward_apool").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("mining_sessions_challenge_unique").on(table.challengeId),
    index("mining_sessions_miner_idx").on(table.minerAgentId),
    index("mining_sessions_owner_idx").on(table.ownerAddress),
    index("mining_sessions_status_idx").on(table.status),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    buyerAgentId: text("buyer_agent_id").notNull(),
    coordinatorAgentId: text("coordinator_agent_id").notNull(),
    publicSummary: text("brief").notNull(),
    briefHash: text("brief_hash").notNull(),
    planRoot: text("plan_root"),
    maxWorkerBudgetApool: text("max_worker_budget_apool").notNull(),
    validationReserveApool: text("validation_reserve_apool").notNull(),
    minAgents: integer("min_agents").notNull(),
    maxParallel: integer("max_parallel").notNull(),
    maxTasks: integer("max_tasks").notNull(),
    state: text("state").notNull().default("PENDING_CHAIN"),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    txHash: text("tx_hash").notNull(),
    chainProjectId: text("chain_project_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("projects_buyer_idx").on(table.buyerAgentId),
    index("projects_coordinator_idx").on(table.coordinatorAgentId),
    index("projects_state_idx").on(table.state),
    uniqueIndex("projects_tx_hash_unique").on(table.txHash),
  ],
);

export const projectTasks = sqliteTable(
  "project_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workerAgentId: text("worker_agent_id").notNull(),
    title: text("title").notNull(),
    strategy: text("strategy").notNull(),
    priceApool: text("price_apool").notNull(),
    validationFeeApool: text("validation_fee_apool").notNull(),
    verifierId: text("verifier_id").notNull(),
    dependenciesJson: text("dependencies_json").notNull(),
    requirementsHash: text("requirements_hash").notNull(),
    deliveryHash: text("delivery_hash"),
    state: text("state").notNull().default("PLANNED"),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    txHash: text("tx_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("project_tasks_project_idx").on(table.projectId),
    index("project_tasks_worker_idx").on(table.workerAgentId),
    index("project_tasks_state_idx").on(table.state),
  ],
);

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    evaluatorAgentId: text("evaluator_agent_id").notNull(),
    phase: text("phase").notNull(),
    decision: text("decision"),
    evidenceHash: text("evidence_hash"),
    commitment: text("commitment"),
    bondApool: text("bond_apool").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("evaluations_job_idx").on(table.jobId),
    index("evaluations_evaluator_idx").on(table.evaluatorAgentId),
  ],
);

export const miningEpochs = sqliteTable(
  "mining_epochs",
  {
    epoch: integer("epoch").primaryKey(),
    budgetApool: text("budget_apool").notNull(),
    eligibleWorkApool: text("eligible_work_apool").notNull().default("0"),
    contributionScore: real("contribution_score").notNull().default(0),
    rewardRoot: text("reward_root"),
    status: text("status").notNull().default("scheduled"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
    claimableAt: integer("claimable_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("mining_epochs_status_idx").on(table.status)],
);

export const protocolEvents = sqliteTable(
  "protocol_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    entityId: text("entity_id").notNull(),
    actorAddress: text("actor_address"),
    payloadJson: text("payload_json").notNull(),
    chainId: integer("chain_id").notNull().default(84532),
    blockNumber: integer("block_number"),
    logIndex: integer("log_index"),
    txHash: text("tx_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("protocol_events_type_idx").on(table.type),
    index("protocol_events_entity_idx").on(table.entityId),
    index("protocol_events_created_idx").on(table.createdAt),
    uniqueIndex("protocol_events_chain_log_unique").on(
      table.chainId,
      table.txHash,
      table.logIndex,
    ),
  ],
);

export const chainCursors = sqliteTable(
  "chain_cursors",
  {
    chainId: integer("chain_id").primaryKey(),
    lastFinalizedBlock: integer("last_finalized_block").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const securityIncidents = sqliteTable(
  "security_incidents",
  {
    id: text("id").primaryKey(),
    incidentTxHash: text("incident_tx_hash").notNull(),
    cause: text("cause").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    amountApool: text("amount_apool").notNull(),
    evidenceUrl: text("evidence_url").notNull(),
    safeTxHash: text("safe_tx_hash"),
    status: text("status").notNull().default("announced"),
    announcedAt: integer("announced_at", { mode: "timestamp_ms" }).notNull(),
    executableAt: integer("executable_at", { mode: "timestamp_ms" }).notNull(),
    executedAt: integer("executed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("security_incidents_tx_unique").on(table.incidentTxHash),
    index("security_incidents_status_idx").on(table.status),
  ],
);

export const apiNonces = sqliteTable(
  "api_nonces",
  {
    address: text("address").primaryKey(),
    nonce: text("nonce").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("api_nonces_expires_idx").on(table.expiresAt)],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    actorAddress: text("actor_address").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json").notNull(),
    statusCode: integer("status_code").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idempotency_keys_expires_idx").on(table.expiresAt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    key: text("key").primaryKey(),
    ownerAgentId: text("owner_agent_id").notNull(),
    jobId: text("job_id"),
    contentHash: text("content_hash").notNull(),
    ciphertextHash: text("ciphertext_hash").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    encryptionSuite: text("encryption_suite").notNull().default("HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305"),
    keyEnvelope: text("key_envelope"),
    status: text("status").notNull().default("sealed"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("artifacts_ciphertext_hash_unique").on(table.ciphertextHash),
    index("artifacts_job_idx").on(table.jobId),
  ],
);

export const v41ExecutionProfiles = sqliteTable(
  "v41_execution_profiles",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    capability: text("capability").notNull(),
    runtimeHash: text("runtime_hash").notNull(),
    modelHash: text("model_hash").notNull(),
    conservativeSuccessBps: integer("conservative_success_bps").notNull().default(0),
    p50LatencyMs: integer("p50_latency_ms").notNull().default(0),
    p95LatencyMs: integer("p95_latency_ms").notNull().default(0),
    reproducibleResults: integer("reproducible_results").notNull().default(0),
    externalResults: integer("external_results").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v41_profiles_agent_runtime_track_unique").on(
      table.agentId,
      table.runtimeHash,
      table.capability,
    ),
    index("v41_profiles_capability_idx").on(table.capability),
    index("v41_profiles_owner_idx").on(table.ownerAddress),
  ],
);

export const v41Opportunities = sqliteTable(
  "v41_opportunities",
  {
    id: text("id").primaryKey(),
    market: text("market").notNull(),
    fundingSource: text("funding_source").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    capability: text("capability").notNull(),
    specificationHash: text("specification_hash").notNull(),
    releaseId: text("release_id").notNull(),
    proofPolicy: text("proof_policy").notNull(),
    maxBudgetApool: text("max_budget_apool").notNull(),
    estimatedCostApool: text("estimated_cost_apool").notNull(),
    riskBps: integer("risk_bps").notNull(),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state").notNull().default("OPEN"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("v41_opportunities_market_idx").on(table.market),
    index("v41_opportunities_state_idx").on(table.state),
    index("v41_opportunities_deadline_idx").on(table.deadlineAt),
  ],
);

export const v41Bids = sqliteTable(
  "v41_bids",
  {
    id: text("id").primaryKey(),
    opportunityId: text("opportunity_id").notNull(),
    bidderAddress: text("bidder_address").notNull(),
    profileId: text("profile_id").notNull(),
    commitment: text("commitment").notNull(),
    priceApool: text("price_apool"),
    capacityUnits: integer("capacity_units"),
    revealSaltHash: text("reveal_salt_hash"),
    state: text("state").notNull().default("COMMITTED"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revealedAt: integer("revealed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("v41_bids_opportunity_bidder_unique").on(
      table.opportunityId,
      table.bidderAddress,
    ),
    index("v41_bids_state_idx").on(table.state),
  ],
);

export const v41Assignments = sqliteTable(
  "v41_assignments",
  {
    id: text("id").primaryKey(),
    opportunityId: text("opportunity_id").notNull(),
    workerAddress: text("worker_address").notNull(),
    profileId: text("profile_id").notNull(),
    market: text("market").notNull(),
    fundingSource: text("funding_source").notNull(),
    releaseId: text("release_id").notNull(),
    policyHash: text("policy_hash").notNull(),
    awardedApool: text("awarded_apool").notNull(),
    reservedApool: text("reserved_apool").notNull(),
    state: text("state").notNull().default("AWARDED"),
    deliveryHash: text("delivery_hash"),
    proofCommitment: text("proof_commitment"),
    proofHash: text("proof_hash"),
    txHash: text("tx_hash"),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v41_assignments_opportunity_unique").on(table.opportunityId),
    index("v41_assignments_worker_idx").on(table.workerAddress),
    index("v41_assignments_state_idx").on(table.state),
  ],
);

export const v41ChainAssignments = sqliteTable(
  "v41_chain_assignments",
  {
    assignmentId: text("assignment_id").primaryKey(),
    chainId: integer("chain_id").notNull().default(84532),
    vaultAddress: text("vault_address").notNull(),
    openTxHash: text("open_tx_hash").notNull(),
    acceptTxHash: text("accept_tx_hash"),
    deliverTxHash: text("deliver_tx_hash"),
    settleTxHash: text("settle_tx_hash"),
    expireTxHash: text("expire_tx_hash"),
    lastBlock: integer("last_block").notNull(),
    state: text("state").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v41_chain_assignments_open_tx_unique").on(table.openTxHash),
    uniqueIndex("v41_chain_assignments_accept_tx_unique").on(table.acceptTxHash),
    uniqueIndex("v41_chain_assignments_deliver_tx_unique").on(table.deliverTxHash),
    uniqueIndex("v41_chain_assignments_settle_tx_unique").on(table.settleTxHash),
    uniqueIndex("v41_chain_assignments_expire_tx_unique").on(table.expireTxHash),
    index("v41_chain_assignments_state_idx").on(table.state),
    index("v41_chain_assignments_block_idx").on(table.lastBlock),
  ],
);

export const v41CapabilitySessions = sqliteTable(
  "v41_capability_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    profileId: text("profile_id").notNull(),
    track: text("track").notNull(),
    challengeCommitment: text("challenge_commitment").notNull(),
    submissionHash: text("submission_hash"),
    scoreBps: integer("score_bps"),
    latencyMs: integer("latency_ms"),
    rewardApool: text("reward_apool").notNull(),
    state: text("state").notNull().default("ACTIVE"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("v41_capability_active_profile_track_unique").on(
      table.profileId,
      table.track,
      table.challengeCommitment,
    ),
    index("v41_capability_owner_idx").on(table.ownerAddress),
    index("v41_capability_state_idx").on(table.state),
  ],
);

export const v41SystemIssues = sqliteTable(
  "v41_system_issues",
  {
    id: text("id").primaryKey(),
    reporterAddress: text("reporter_address").notNull(),
    issueCommitment: text("issue_commitment").notNull(),
    evidenceHash: text("evidence_hash"),
    reproductionHash: text("reproduction_hash"),
    affectedReleaseId: text("affected_release_id"),
    maxBudgetApool: text("max_budget_apool"),
    state: text("state").notNull().default("COMMITTED"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revealedAt: integer("revealed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v41_system_issue_commitment_unique").on(table.issueCommitment),
    index("v41_system_issue_state_idx").on(table.state),
  ],
);

export const v41Proofs = sqliteTable(
  "v41_proofs",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    verifierAddress: text("verifier_address").notNull(),
    commitment: text("commitment").notNull(),
    decision: text("decision"),
    evidenceHash: text("evidence_hash"),
    saltHash: text("salt_hash"),
    state: text("state").notNull().default("COMMITTED"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revealedAt: integer("revealed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("v41_proofs_assignment_verifier_unique").on(
      table.assignmentId,
      table.verifierAddress,
    ),
    index("v41_proofs_state_idx").on(table.state),
  ],
);

export const v41Artifacts = sqliteTable(
  "v41_artifacts",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    authorAddress: text("author_address").notNull(),
    contentHash: text("content_hash").notNull(),
    provenanceHash: text("provenance_hash").notNull(),
    licenseHash: text("license_hash").notNull(),
    releaseId: text("release_id").notNull(),
    capability: text("capability").notNull(),
    proofHash: text("proof_hash").notNull(),
    reusePriceApool: text("reuse_price_apool").notNull().default("0"),
    state: text("state").notNull().default("PROVEN"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v41_artifacts_content_unique").on(table.contentHash),
    index("v41_artifacts_capability_idx").on(table.capability),
    index("v41_artifacts_release_idx").on(table.releaseId),
  ],
);

export const v41EpochAccounting = sqliteTable(
  "v41_epoch_accounting",
  {
    epoch: integer("epoch").primaryKey(),
    allowanceApool: text("allowance_apool").notNull(),
    capabilityReservedApool: text("capability_reserved_apool").notNull().default("0"),
    capabilityMintedApool: text("capability_minted_apool").notNull().default("0"),
    basicReservedApool: text("basic_reserved_apool").notNull().default("0"),
    basicMintedApool: text("basic_minted_apool").notNull().default("0"),
    systemReservedApool: text("system_reserved_apool").notNull().default("0"),
    systemMintedApool: text("system_minted_apool").notNull().default("0"),
    validationReservedApool: text("validation_reserved_apool").notNull().default("0"),
    validationMintedApool: text("validation_minted_apool").notNull().default("0"),
    experimentalMintedApool: text("experimental_minted_apool").notNull().default("0"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const v43GasGrantDailyBudgets = sqliteTable(
  "v43_gas_grant_daily_budgets",
  {
    dayBucket: integer("day_bucket").primaryKey(),
    grantCount: integer("grant_count").notNull().default(0),
    amountWei: integer("amount_wei").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const v43GasGrants = sqliteTable(
  "v43_gas_grants",
  {
    id: text("id").primaryKey(),
    requestEventId: text("request_event_id").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    dayBucket: integer("day_bucket").notNull(),
    amountWei: integer("amount_wei").notNull(),
    balanceBeforeWei: integer("balance_before_wei").notNull(),
    status: text("status").notNull(),
    txHash: text("tx_hash"),
    blockNumber: integer("block_number"),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("v43_gas_grants_request_event_unique").on(
      table.requestEventId,
    ),
    uniqueIndex("v43_gas_grants_recipient_day_unique").on(
      table.recipientAddress,
      table.dayBucket,
    ),
    uniqueIndex("v43_gas_grants_tx_hash_unique").on(table.txHash),
    index("v43_gas_grants_status_idx").on(table.status),
    index("v43_gas_grants_created_idx").on(table.createdAt),
  ],
);
