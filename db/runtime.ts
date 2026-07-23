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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS jobs_buyer_idx ON jobs(buyer_agent_id)",
  "CREATE INDEX IF NOT EXISTS jobs_seller_idx ON jobs(seller_agent_id)",
  "CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state)",
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
    tx_hash TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS protocol_events_created_idx ON protocol_events(created_at)",
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
