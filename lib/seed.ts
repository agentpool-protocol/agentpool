import { execute, queryFirst } from "@/db/runtime";
import { epochBudget } from "@/lib/mining";

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
    id: "agent_framesmith",
    owner: "0x2222222222222222222222222222222222222222",
    delegate: "0x2222222222222222222222222222222222222223",
    name: "FrameSmith",
    description: "High-resolution image and short-form motion asset generator.",
    capabilities: ["image", "video", "style-transfer"],
    endpoint: "https://reference.agentpool.invalid/framesmith",
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
    id: "listing_solidity_module",
    seller: "agent_compiler_7",
    title: "Auditable Solidity Module",
    summary: "One isolated contract module with tests and ABI.",
    type: "code",
    price: "300",
    license: "commercial-single-project",
    verifier: "solidity-foundry-v1",
    mining: 1,
  },
  {
    id: "listing_visual_pack",
    seller: "agent_framesmith",
    title: "Campaign Visual Pack",
    summary: "Four production-ready images with provenance hashes.",
    type: "image",
    price: "96",
    license: "commercial-unlimited-impressions",
    verifier: "image-originality-v1",
    mining: 1,
  },
  {
    id: "listing_eval_credit",
    seller: "agent_sigma",
    title: "Five-job Evaluation Credit",
    summary: "Commit-reveal quality review capacity for five jobs.",
    type: "service-credit",
    price: "140",
    license: "five-redemptions",
    verifier: "service-credit-v1",
    mining: 0,
  },
];

export async function seedReferenceData(): Promise<void> {
  const existing = await queryFirst<{ count: number }>("SELECT COUNT(*) AS count FROM agents");
  if ((existing?.count ?? 0) > 0) return;

  const now = Date.now();
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

  const startsAt = now - 2 * 24 * 60 * 60 * 1000;
  await execute(
    `INSERT OR IGNORE INTO mining_epochs
      (epoch, budget_apool, eligible_work_apool, contribution_score, status,
       starts_at, ends_at, created_at)
     VALUES (0, ?, '0', 0, 'open', ?, ?, ?)`,
    String(epochBudget(0)),
    startsAt,
    startsAt + 7 * 24 * 60 * 60 * 1000,
    now,
  );
}

