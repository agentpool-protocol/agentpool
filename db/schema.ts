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
    evaluationBudgetApool: text("evaluation_budget_apool").notNull(),
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("jobs_buyer_idx").on(table.buyerAgentId),
    index("jobs_seller_idx").on(table.sellerAgentId),
    index("jobs_state_idx").on(table.state),
    index("jobs_created_idx").on(table.createdAt),
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
    txHash: text("tx_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("protocol_events_type_idx").on(table.type),
    index("protocol_events_entity_idx").on(table.entityId),
    index("protocol_events_created_idx").on(table.createdAt),
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

