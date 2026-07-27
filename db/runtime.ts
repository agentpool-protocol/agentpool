import { env } from "cloudflare:workers";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    owner_address TEXT NOT NULL UNIQUE,
    delegate_address TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    encryption_public_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    completed_jobs INTEGER NOT NULL DEFAULT 0,
    disputed_jobs INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS agents_score_idx ON agents(score)",
  "CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status)",
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    price_mode TEXT NOT NULL,
    price_apool TEXT NOT NULL,
    license_type TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    content_hash TEXT,
    resale_allowed INTEGER NOT NULL DEFAULT 0,
    mining_eligible INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS listings_seller_idx ON listings(seller_agent_id)",
  "CREATE INDEX IF NOT EXISTS listings_asset_type_idx ON listings(asset_type)",
  "CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(status)",
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    listing_id TEXT,
    buyer_agent_id TEXT NOT NULL,
    seller_agent_id TEXT NOT NULL,
    price_apool TEXT NOT NULL,
    evaluation_budget_apool TEXT NOT NULL,
    seller_bond_apool TEXT NOT NULL,
    state TEXT NOT NULL,
    requirements_hash TEXT NOT NULL,
    delivery_hash TEXT,
    artifact_key TEXT,
    verifier_id TEXT NOT NULL,
    outcome TEXT,
    deadline_at INTEGER NOT NULL,
    challenge_deadline_at INTEGER,
    tx_hash TEXT,
    chain_job_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS jobs_buyer_idx ON jobs(buyer_agent_id)",
  "CREATE INDEX IF NOT EXISTS jobs_seller_idx ON jobs(seller_agent_id)",
  "CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state)",
  "CREATE UNIQUE INDEX IF NOT EXISTS jobs_tx_hash_unique ON jobs(tx_hash)",
  `CREATE TABLE IF NOT EXISTS benchmark_challenges (
    id TEXT PRIMARY KEY,
    track TEXT NOT NULL,
    league TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    commitment_hash TEXT NOT NULL,
    base_reward_apool TEXT NOT NULL,
    generator_agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'committed',
    reveal_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS benchmark_challenges_track_idx ON benchmark_challenges(track)",
  "CREATE INDEX IF NOT EXISTS benchmark_challenges_status_idx ON benchmark_challenges(status)",
  "CREATE INDEX IF NOT EXISTS benchmark_challenges_created_idx ON benchmark_challenges(created_at)",
  `CREATE TABLE IF NOT EXISTS benchmark_submissions (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    miner_agent_id TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    accuracy_bps INTEGER,
    efficiency_bps INTEGER,
    reward_apool TEXT,
    receipt_digest TEXT,
    artifact_key TEXT,
    receipt_json TEXT,
    signatures_json TEXT,
    claim_calldata TEXT,
    claim_tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at INTEGER NOT NULL,
    verified_at INTEGER,
    claimed_at INTEGER,
    UNIQUE(challenge_id, miner_agent_id)
  )`,
  "CREATE INDEX IF NOT EXISTS benchmark_submissions_miner_idx ON benchmark_submissions(miner_agent_id)",
  "CREATE INDEX IF NOT EXISTS benchmark_submissions_status_idx ON benchmark_submissions(status)",
  `CREATE TABLE IF NOT EXISTS mining_sessions (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL UNIQUE,
    miner_agent_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    track TEXT NOT NULL,
    payload_key TEXT NOT NULL,
    assignment_hash TEXT NOT NULL,
    reward_apool TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS mining_sessions_miner_idx ON mining_sessions(miner_agent_id)",
  "CREATE INDEX IF NOT EXISTS mining_sessions_owner_idx ON mining_sessions(owner_address)",
  "CREATE INDEX IF NOT EXISTS mining_sessions_status_idx ON mining_sessions(status)",
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    buyer_agent_id TEXT NOT NULL,
    coordinator_agent_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    brief_hash TEXT NOT NULL,
    plan_root TEXT,
    max_worker_budget_apool TEXT NOT NULL,
    validation_reserve_apool TEXT NOT NULL,
    min_agents INTEGER NOT NULL,
    max_parallel INTEGER NOT NULL,
    max_tasks INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING_CHAIN',
    deadline_at INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    chain_project_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS projects_buyer_idx ON projects(buyer_agent_id)",
  "CREATE INDEX IF NOT EXISTS projects_coordinator_idx ON projects(coordinator_agent_id)",
  "CREATE INDEX IF NOT EXISTS projects_state_idx ON projects(state)",
  "CREATE UNIQUE INDEX IF NOT EXISTS projects_tx_hash_unique ON projects(tx_hash)",
  `CREATE TABLE IF NOT EXISTS project_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worker_agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    strategy TEXT NOT NULL,
    price_apool TEXT NOT NULL,
    validation_fee_apool TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    requirements_hash TEXT NOT NULL,
    delivery_hash TEXT,
    state TEXT NOT NULL DEFAULT 'PLANNED',
    deadline_at INTEGER NOT NULL,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks(project_id)",
  "CREATE INDEX IF NOT EXISTS project_tasks_worker_idx ON project_tasks(worker_agent_id)",
  "CREATE INDEX IF NOT EXISTS project_tasks_state_idx ON project_tasks(state)",
  `CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    evaluator_agent_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    decision TEXT,
    evidence_hash TEXT,
    commitment TEXT,
    bond_apool TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS evaluations_job_idx ON evaluations(job_id)",
  `CREATE TABLE IF NOT EXISTS mining_epochs (
    epoch INTEGER PRIMARY KEY,
    budget_apool TEXT NOT NULL,
    eligible_work_apool TEXT NOT NULL DEFAULT '0',
    contribution_score REAL NOT NULL DEFAULT 0,
    reward_root TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    claimable_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS protocol_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor_address TEXT,
    payload_json TEXT NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 84532,
    block_number INTEGER,
    log_index INTEGER,
    tx_hash TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS protocol_events_created_idx ON protocol_events(created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS protocol_events_chain_log_unique ON protocol_events(chain_id, tx_hash, log_index)",
  `CREATE TABLE IF NOT EXISTS chain_cursors (
    chain_id INTEGER PRIMARY KEY,
    last_finalized_block INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS security_incidents (
    id TEXT PRIMARY KEY,
    incident_tx_hash TEXT NOT NULL UNIQUE,
    cause TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_apool TEXT NOT NULL,
    evidence_url TEXT NOT NULL,
    safe_tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'announced',
    announced_at INTEGER NOT NULL,
    executable_at INTEGER NOT NULL,
    executed_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS security_incidents_status_idx ON security_incidents(status)",
  `CREATE TABLE IF NOT EXISTS api_nonces (
    address TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    actor_address TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    key TEXT PRIMARY KEY,
    owner_agent_id TEXT NOT NULL,
    job_id TEXT,
    content_hash TEXT NOT NULL,
    ciphertext_hash TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    encryption_suite TEXT NOT NULL,
    key_envelope TEXT,
    status TEXT NOT NULL DEFAULT 'sealed',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS v41_execution_profiles (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    capability TEXT NOT NULL,
    runtime_hash TEXT NOT NULL,
    model_hash TEXT NOT NULL,
    conservative_success_bps INTEGER NOT NULL DEFAULT 0,
    p50_latency_ms INTEGER NOT NULL DEFAULT 0,
    p95_latency_ms INTEGER NOT NULL DEFAULT 0,
    reproducible_results INTEGER NOT NULL DEFAULT 0,
    external_results INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(agent_id, runtime_hash, capability)
  )`,
  "CREATE INDEX IF NOT EXISTS v41_profiles_capability_idx ON v41_execution_profiles(capability)",
  "CREATE INDEX IF NOT EXISTS v41_profiles_owner_idx ON v41_execution_profiles(owner_address)",
  `CREATE TABLE IF NOT EXISTS v41_opportunities (
    id TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    funding_source TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    capability TEXT NOT NULL,
    specification_hash TEXT NOT NULL,
    release_id TEXT NOT NULL,
    proof_policy TEXT NOT NULL,
    max_budget_apool TEXT NOT NULL,
    estimated_cost_apool TEXT NOT NULL,
    risk_bps INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'OPEN',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS v41_opportunities_market_idx ON v41_opportunities(market)",
  "CREATE INDEX IF NOT EXISTS v41_opportunities_state_idx ON v41_opportunities(state)",
  "CREATE INDEX IF NOT EXISTS v41_opportunities_deadline_idx ON v41_opportunities(deadline_at)",
  `CREATE TABLE IF NOT EXISTS v41_bids (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    bidder_address TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    commitment TEXT NOT NULL,
    price_apool TEXT,
    capacity_units INTEGER,
    reveal_salt_hash TEXT,
    state TEXT NOT NULL DEFAULT 'COMMITTED',
    created_at INTEGER NOT NULL,
    revealed_at INTEGER,
    UNIQUE(opportunity_id, bidder_address)
  )`,
  "CREATE INDEX IF NOT EXISTS v41_bids_state_idx ON v41_bids(state)",
  `CREATE TABLE IF NOT EXISTS v41_assignments (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL UNIQUE,
    worker_address TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    market TEXT NOT NULL,
    funding_source TEXT NOT NULL,
    release_id TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    awarded_apool TEXT NOT NULL,
    reserved_apool TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'AWARDED',
    delivery_hash TEXT,
    proof_commitment TEXT,
    proof_hash TEXT,
    tx_hash TEXT,
    deadline_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS v41_assignments_worker_idx ON v41_assignments(worker_address)",
  "CREATE INDEX IF NOT EXISTS v41_assignments_state_idx ON v41_assignments(state)",
  `CREATE TABLE IF NOT EXISTS v41_chain_assignments (
    assignment_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL DEFAULT 84532,
    vault_address TEXT NOT NULL,
    open_tx_hash TEXT NOT NULL UNIQUE,
    accept_tx_hash TEXT UNIQUE,
    deliver_tx_hash TEXT UNIQUE,
    settle_tx_hash TEXT UNIQUE,
    expire_tx_hash TEXT UNIQUE,
    last_block INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS v41_chain_assignments_state_idx ON v41_chain_assignments(state)",
  "CREATE INDEX IF NOT EXISTS v41_chain_assignments_block_idx ON v41_chain_assignments(last_block)",
  `CREATE TABLE IF NOT EXISTS v41_capability_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    track TEXT NOT NULL,
    challenge_commitment TEXT NOT NULL,
    submission_hash TEXT,
    score_bps INTEGER,
    latency_ms INTEGER,
    reward_apool TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    UNIQUE(profile_id, track, challenge_commitment)
  )`,
  "CREATE INDEX IF NOT EXISTS v41_capability_owner_idx ON v41_capability_sessions(owner_address)",
  "CREATE INDEX IF NOT EXISTS v41_capability_state_idx ON v41_capability_sessions(state)",
  `CREATE TABLE IF NOT EXISTS v41_system_issues (
    id TEXT PRIMARY KEY,
    reporter_address TEXT NOT NULL,
    issue_commitment TEXT NOT NULL UNIQUE,
    evidence_hash TEXT,
    reproduction_hash TEXT,
    affected_release_id TEXT,
    max_budget_apool TEXT,
    state TEXT NOT NULL DEFAULT 'COMMITTED',
    created_at INTEGER NOT NULL,
    revealed_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS v41_system_issue_state_idx ON v41_system_issues(state)",
  `CREATE TABLE IF NOT EXISTS v41_proofs (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    verifier_address TEXT NOT NULL,
    commitment TEXT NOT NULL,
    decision TEXT,
    evidence_hash TEXT,
    salt_hash TEXT,
    state TEXT NOT NULL DEFAULT 'COMMITTED',
    created_at INTEGER NOT NULL,
    revealed_at INTEGER,
    UNIQUE(assignment_id, verifier_address)
  )`,
  "CREATE INDEX IF NOT EXISTS v41_proofs_state_idx ON v41_proofs(state)",
  `CREATE TABLE IF NOT EXISTS v41_artifacts (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    author_address TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    provenance_hash TEXT NOT NULL,
    license_hash TEXT NOT NULL,
    release_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    proof_hash TEXT NOT NULL,
    reuse_price_apool TEXT NOT NULL DEFAULT '0',
    state TEXT NOT NULL DEFAULT 'PROVEN',
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS v41_artifacts_capability_idx ON v41_artifacts(capability)",
  "CREATE INDEX IF NOT EXISTS v41_artifacts_release_idx ON v41_artifacts(release_id)",
  `CREATE TABLE IF NOT EXISTS v41_epoch_accounting (
    epoch INTEGER PRIMARY KEY,
    allowance_apool TEXT NOT NULL,
    capability_reserved_apool TEXT NOT NULL DEFAULT '0',
    capability_minted_apool TEXT NOT NULL DEFAULT '0',
    basic_reserved_apool TEXT NOT NULL DEFAULT '0',
    basic_minted_apool TEXT NOT NULL DEFAULT '0',
    system_reserved_apool TEXT NOT NULL DEFAULT '0',
    system_minted_apool TEXT NOT NULL DEFAULT '0',
    validation_reserved_apool TEXT NOT NULL DEFAULT '0',
    validation_minted_apool TEXT NOT NULL DEFAULT '0',
    experimental_minted_apool TEXT NOT NULL DEFAULT '0',
    updated_at INTEGER NOT NULL
  )`,
];

let initialized: Promise<void> | undefined;

export function getD1(): D1Database {
  if (!env.DB) {
    throw new Error("D1 binding DB is unavailable");
  }
  return env.DB;
}

export function getR2(): R2Bucket {
  if (!env.ASSETS_BUCKET) {
    throw new Error("R2 binding ASSETS_BUCKET is unavailable");
  }
  return env.ASSETS_BUCKET;
}

export async function ensureSchema(): Promise<void> {
  if (!initialized) {
    const database = getD1();
    initialized = database
      .batch(schemaStatements.map((statement) => database.prepare(statement)))
      .then(() => undefined)
      .catch((error: unknown) => {
        initialized = undefined;
        throw error;
      });
  }
  return initialized;
}

export async function queryAll<T>(
  statement: string,
  ...bindings: unknown[]
): Promise<T[]> {
  await ensureSchema();
  const result = await getD1().prepare(statement).bind(...bindings).all<T>();
  return result.results;
}

export async function queryFirst<T>(
  statement: string,
  ...bindings: unknown[]
): Promise<T | null> {
  await ensureSchema();
  return getD1().prepare(statement).bind(...bindings).first<T>();
}

export async function execute(
  statement: string,
  ...bindings: unknown[]
): Promise<D1Result<unknown>> {
  await ensureSchema();
  return getD1().prepare(statement).bind(...bindings).run();
}

export async function executeBatch(
  statements: Array<{ sql: string; bindings?: unknown[] }>,
): Promise<D1Result<unknown>[]> {
  await ensureSchema();
  const database = getD1();
  return database.batch(
    statements.map(({ sql, bindings = [] }) =>
      database.prepare(sql).bind(...bindings),
    ),
  );
}
