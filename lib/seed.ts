import { execute } from "@/db/runtime";

const referenceAgents = [
  {
    id: "agent_compiler_7",
    owner: "0x1111111111111111111111111111111111111111",
    delegate: "0x1111111111111111111111111111111111111112",
    name: "Compiler-7",
    description: "Deterministic TypeScript and Solidity module builder.",
    capabilities: ["code", "tests", "solidity"],
    endpoint: "https://reference.agentpool.invalid/compiler-7",
    score: 94.8,
    completed: 1284,
    disputed: 9,
  },
  {
    id: "agent_indexforge",
    owner: "0x4444444444444444444444444444444444444444",
    delegate: "0x4444444444444444444444444444444444444445",
    name: "IndexForge",
    description: "Deterministic schema transformation and data normalization agent.",
    capabilities: ["data", "json", "csv", "schema"],
    endpoint: "https://reference.agentpool.invalid/indexforge",
    score: 91.3,
    completed: 8421,
    disputed: 31,
  },
  {
    id: "agent_sigma",
    owner: "0x3333333333333333333333333333333333333333",
    delegate: "0x3333333333333333333333333333333333333334",
    name: "Verifier-Sigma",
    description: "Staked evaluator for deterministic and originality checks.",
    capabilities: ["evaluation", "similarity", "sandbox"],
    endpoint: "https://reference.agentpool.invalid/verifier-sigma",
    score: 97.1,
    completed: 3562,
    disputed: 14,
  },
];

const referenceListings = [
  {
    id: "listing_v2_solidity_module",
    seller: "agent_compiler_7",
    title: "Auditable Solidity Module",
    summary: "One isolated contract module with tests and ABI.",
    type: "code",
    price: "1000",
    license: "commercial-single-project",
    verifier: "solidity-foundry-v2",
    mining: 0,
  },
  {
    id: "listing_v2_schema_normalization",
    seller: "agent_indexforge",
    title: "Schema-safe Normalization",
    summary: "One deterministic JSON or CSV normalization run with invariant evidence.",
    type: "dataset",
    price: "2500",
    license: "commercial-single-project",
    verifier: "json-schema-v2",
    mining: 0,
  },
  {
    id: "listing_v2_validation_credit",
    seller: "agent_sigma",
    title: "Five-job Evaluation Credit",
    summary: "Commit-reveal quality review capacity for five jobs.",
    type: "service-credit",
    price: "140",
    license: "five-redemptions",
    verifier: "api-contract-v1",
    mining: 0,
  },
];

export async function seedReferenceData(): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE listings SET status = 'deprecated', updated_at = ?
     WHERE id IN ('listing_solidity_module', 'listing_visual_pack', 'listing_eval_credit')`,
    now,
  );
  for (const agent of referenceAgents) {
    await execute(
      `INSERT OR IGNORE INTO agents
        (id, owner_address, delegate_address, name, description, capabilities_json,
         encryption_public_key, endpoint, score, completed_jobs, disputed_jobs,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reference', ?, ?)`,
      agent.id,
      agent.owner,
      agent.delegate,
      agent.name,
      agent.description,
      JSON.stringify(agent.capabilities),
      `x25519:${agent.id}:testnet-reference`,
      agent.endpoint,
      agent.score,
      agent.completed,
      agent.disputed,
      now,
      now,
    );
  }

  for (const listing of referenceListings) {
    await execute(
      `INSERT OR IGNORE INTO listings
        (id, seller_agent_id, title, summary, asset_type, price_mode, price_apool,
         license_type, verifier_id, resale_allowed, mining_eligible, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'fixed', ?, ?, ?, 0, ?, 'active', ?, ?)`,
      listing.id,
      listing.seller,
      listing.title,
      listing.summary,
      listing.type,
      listing.price,
      listing.license,
      listing.verifier,
      listing.mining,
      now,
      now,
    );
  }

}
