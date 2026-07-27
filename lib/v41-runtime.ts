import { env } from "cloudflare:workers";
import { execute, executeBatch, queryAll, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import {
  V41,
  expectedNetProfit,
  stableJson,
  type V41Market,
  v41Hash,
} from "@/lib/v41";
import {
  V41_DEPLOYMENT,
  V41_SMOKE,
  v41ChainStatus,
} from "@/lib/v41-chain";
import externalPilot from "@/protocol/v41-external-pilot.json";

interface V41OpportunityRow {
  id: string;
  market: V41Market;
  funding_source: string;
  title: string;
  summary: string;
  capability: string;
  specification_hash: string;
  release_id: string;
  proof_policy: string;
  max_budget_apool: string;
  estimated_cost_apool: string;
  risk_bps: number;
  deadline_at: number;
  state: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const WEEK = 7 * 24 * 60 * 60 * 1_000;
const SESSION_TTL = 20 * 60 * 1_000;

function referenceOpportunities(now: number) {
  const releaseId = v41Hash({ release: "v4.1-alpha", policy: "objective-hash-v1" });
  return [
    {
      id: "v41-capability-json-1",
      market: "CAPABILITY",
      fundingSource: "CORE_EPOCH",
      title: "JSON capability refresh",
      summary: "A private nonce-bound normalization check used only to refresh routing evidence.",
      capability: "data.json.normalize",
      maxBudget: "20",
      estimatedCost: "4",
      riskBps: 500,
      proofPolicy: "PRIVATE_DERIVED_CHALLENGE",
    },
    {
      id: "v41-basic-mcp-fixture-1",
      market: "BASIC",
      fundingSource: "CORE_EPOCH",
      title: "MCP compatibility fixture corpus",
      summary: "Produce deterministic request/response fixtures that remain as a reusable public artifact.",
      capability: "protocol.mcp.fixture",
      maxBudget: "360",
      estimatedCost: "120",
      riskBps: 1_200,
      proofPolicy: "HASH_LOCKED_REPRODUCIBLE_RESULT",
    },
    {
      id: "v41-basic-indexer-backfill-1",
      market: "BASIC",
      fundingSource: "CORE_EPOCH",
      title: "Indexer backfill verification slice",
      summary: "Reconstruct an event slice and prove that the ordered event root matches the committed reference.",
      capability: "chain.indexer.backfill",
      maxBudget: "520",
      estimatedCost: "190",
      riskBps: 1_500,
      proofPolicy: "HASH_LOCKED_REPRODUCIBLE_RESULT",
    },
    {
      id: "v41-system-shadow-runner-1",
      market: "SYSTEM",
      fundingSource: "EVOLUTION_EPOCH",
      title: "Shadow-runner isolation hardening",
      summary: "Candidate module work is visible, but emission remains disabled until the canary proof adapter is independently audited.",
      capability: "agentpool.runner.security",
      maxBudget: "900",
      estimatedCost: "480",
      riskBps: 3_500,
      proofPolicy: "SHADOW_ONLY_NO_EMISSION",
    },
  ].map((opportunity) => ({
    ...opportunity,
    releaseId,
    specificationHash: v41Hash({
      id: opportunity.id,
      capability: opportunity.capability,
      proofPolicy: opportunity.proofPolicy,
    }),
    deadlineAt: now + 4 * WEEK,
  }));
}

export async function ensureV41Seed(): Promise<void> {
  const existing = await queryFirst<{ count: number }>(
    "SELECT COUNT(*) AS count FROM v41_opportunities",
  );
  const now = Date.now();
  if ((existing?.count ?? 0) !== 0) {
    await execute(
      `UPDATE v41_opportunities
       SET deadline_at = ?, updated_at = ?
       WHERE created_by = 'agentpool-v4.1-bootstrap'
         AND deadline_at <= ?`,
      now + 4 * WEEK,
      now,
      now,
    );
    return;
  }
  await executeBatch(
    referenceOpportunities(now).map((opportunity) => ({
      sql: `INSERT OR IGNORE INTO v41_opportunities
        (id, market, funding_source, title, summary, capability,
         specification_hash, release_id, proof_policy, max_budget_apool,
         estimated_cost_apool, risk_bps, deadline_at, state, created_by,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindings: [
        opportunity.id,
        opportunity.market,
        opportunity.fundingSource,
        opportunity.title,
        opportunity.summary,
        opportunity.capability,
        opportunity.specificationHash,
        opportunity.releaseId,
        opportunity.proofPolicy,
        opportunity.maxBudget,
        opportunity.estimatedCost,
        opportunity.riskBps,
        opportunity.deadlineAt,
        opportunity.market === "SYSTEM" ? "SHADOW_ONLY" : "OPEN",
        "agentpool-v4.1-bootstrap",
        now,
        now,
      ],
    })),
  );
}

export async function listV41Opportunities(input?: {
  market?: V41Market | null;
  state?: string | null;
  agentCostApool?: number;
  successProbabilityBps?: number;
}): Promise<Array<Record<string, unknown>>> {
  await ensureV41Seed();
  const clauses = ["deadline_at > ?"];
  const bindings: unknown[] = [Date.now()];
  if (input?.market) {
    clauses.push("market = ?");
    bindings.push(input.market);
  }
  if (input?.state) {
    clauses.push("state = ?");
    bindings.push(input.state);
  }
  const rows = await queryAll<V41OpportunityRow>(
    `SELECT * FROM v41_opportunities
     WHERE ${clauses.join(" AND ")}
     ORDER BY CAST(max_budget_apool AS INTEGER) DESC, created_at ASC
     LIMIT 100`,
    ...bindings,
  );
  const cost = input?.agentCostApool ?? 0;
  const success = input?.successProbabilityBps ?? 7_500;
  return rows.map((row) => ({
    id: row.id,
    market: row.market,
    fundingSource: row.funding_source,
    title: row.title,
    summary: row.summary,
    capability: row.capability,
    specificationHash: row.specification_hash,
    releaseId: row.release_id,
    proofPolicy: row.proof_policy,
    maxBudgetApool: row.max_budget_apool,
    estimatedCostApool: row.estimated_cost_apool,
    riskBps: row.risk_bps,
    deadlineAt: row.deadline_at,
    state: row.state,
    expectedNetProfitApool: expectedNetProfit({
      successProbabilityBps: success,
      expectedPayoutApool: Number(row.max_budget_apool),
      computeCostApool: cost || Number(row.estimated_cost_apool),
      toolCostApool: 0,
      gasCostApool: 0,
      failureProbabilityBps: 10_000 - success,
      bondLossApool: Math.round(Number(row.max_budget_apool) * row.risk_bps / 10_000),
      verificationCostApool: 0,
      subtaskCostApool: 0,
      opportunityCostApool: 0,
    }),
    ...(row.id === externalPilot.opportunityId
      ? {
          pilot: {
            version: externalPilot.version,
            task: externalPilot.task,
            resultEncoding: "stable-json-utf8-keccak256",
            testnetOnly: true,
          },
        }
      : {}),
  }));
}

function challengeSecret(): string {
  const secret = env.V41_CHALLENGE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("V41_CHALLENGE_SECRET_UNAVAILABLE");
  }
  return secret;
}

async function hmacHex(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(challengeSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveCapabilityChallenge(
  sessionId: string,
  ownerAddress: string,
  track: "math" | "json" | "api",
): Promise<{
  publicChallenge: Record<string, unknown>;
  expectedAnswer: unknown;
  commitment: `0x${string}`;
}> {
  const digest = await hmacHex(`${sessionId}:${ownerAddress.toLowerCase()}:${track}`);
  const number = (offset: number, size: number) =>
    Number.parseInt(digest.slice(offset, offset + size), 16);
  let publicChallenge: Record<string, unknown>;
  let expectedAnswer: unknown;
  if (track === "math") {
    const a = 100 + number(0, 4) % 900;
    const b = 10 + number(4, 4) % 90;
    const c = 2 + number(8, 2) % 8;
    publicChallenge = {
      type: "exact-integer",
      expression: `(${a} + ${b}) * ${c}`,
      response: { answer: "integer" },
    };
    expectedAnswer = { answer: (a + b) * c };
  } else if (track === "json") {
    const rows = [
      { id: `a-${digest.slice(0, 4)}`, score: number(0, 4) % 100 },
      { id: `b-${digest.slice(4, 8)}`, score: number(4, 4) % 100 },
      { id: `a-${digest.slice(0, 4)}`, score: number(8, 4) % 100 },
    ];
    const unique = new Map<string, number>();
    for (const row of rows) unique.set(row.id, Math.max(unique.get(row.id) ?? 0, row.score));
    expectedAnswer = {
      rows: Array.from(unique, ([id, score]) => ({ id, score }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    publicChallenge = {
      type: "json-normalize",
      rules: ["deduplicate by id", "keep highest score", "sort by id ascending"],
      input: rows,
    };
  } else {
    const unit = 1 + number(0, 2) % 9;
    const quantities = [1 + number(2, 2) % 9, 1 + number(4, 2) % 9, 1 + number(6, 2) % 9];
    expectedAnswer = {
      status: 200,
      total: quantities.reduce((sum, quantity) => sum + quantity * unit, 0),
      requestDigest: `0x${digest.slice(0, 32)}`,
    };
    publicChallenge = {
      type: "deterministic-api-fixture",
      unitPrice: unit,
      quantities,
      requestDigest: `0x${digest.slice(0, 32)}`,
    };
  }
  return {
    publicChallenge,
    expectedAnswer,
    commitment: v41Hash({
      sessionId,
      track,
      publicChallenge,
      expectedAnswer,
    }),
  };
}

export async function createCapabilitySession(input: {
  agentId: string;
  ownerAddress: string;
  profileId: string;
  track: "math" | "json" | "api";
  runtimeHash: string;
  modelHash: string;
}): Promise<Record<string, unknown>> {
  const existingProfile = await queryFirst<{ id: string }>(
    `SELECT id FROM v41_execution_profiles
     WHERE agent_id = ? AND runtime_hash = ? AND capability = ?`,
    input.agentId,
    input.runtimeHash,
    input.track,
  );
  const resolvedProfileId = existingProfile?.id ?? input.profileId;
  const fresh = await queryFirst<{ count: number }>(
    `SELECT COUNT(*) AS count FROM v41_capability_sessions
     WHERE profile_id = ? AND track = ? AND state = 'PASSED'
       AND submitted_at > ?`,
    resolvedProfileId,
    input.track,
    Date.now() - 24 * 60 * 60 * 1_000,
  );
  if ((fresh?.count ?? 0) > 0) throw new Error("INVALID_MEASUREMENT_NOT_NEEDED");
  const id = requestId();
  const createdAt = Date.now();
  const challenge = await deriveCapabilityChallenge(
    id,
    input.ownerAddress,
    input.track,
  );
  const rewardApool = "20";
  await executeBatch([
    {
      sql: `INSERT INTO v41_execution_profiles
        (id, agent_id, owner_address, capability, runtime_hash, model_hash,
         conservative_success_bps, p50_latency_ms, p95_latency_ms,
         reproducible_results, external_results, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)
       ON CONFLICT(agent_id, runtime_hash, capability) DO UPDATE SET
         model_hash = excluded.model_hash,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      bindings: [
        resolvedProfileId,
        input.agentId,
        input.ownerAddress,
        input.track,
        input.runtimeHash,
        input.modelHash,
        createdAt + 30 * 24 * 60 * 60 * 1_000,
        createdAt,
        createdAt,
      ],
    },
    {
      sql: `INSERT INTO v41_capability_sessions
        (id, agent_id, owner_address, profile_id, track, challenge_commitment,
         reward_apool, state, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      bindings: [
        id,
        input.agentId,
        input.ownerAddress,
        resolvedProfileId,
        input.track,
        challenge.commitment,
        rewardApool,
        createdAt + SESSION_TTL,
        createdAt,
      ],
    },
  ]);
  return {
    id,
    profileId: resolvedProfileId,
    track: input.track,
    challenge: challenge.publicChallenge,
    challengeCommitment: challenge.commitment,
    expiresAt: createdAt + SESSION_TTL,
    possibleRewardApool: rewardApool,
    rewardStatus: "OFFCHAIN_RESERVED_V41_CHAIN_PENDING",
  };
}

export async function submitCapabilitySession(input: {
  sessionId: string;
  ownerAddress: string;
  answer: unknown;
  latencyMs: number;
}): Promise<Record<string, unknown>> {
  const session = await queryFirst<{
    id: string;
    owner_address: string;
    profile_id: string;
    track: "math" | "json" | "api";
    challenge_commitment: string;
    reward_apool: string;
    state: string;
    expires_at: number;
    created_at: number;
  }>(
    `SELECT id, owner_address, profile_id, track, challenge_commitment,
            reward_apool, state, expires_at, created_at
     FROM v41_capability_sessions WHERE id = ?`,
    input.sessionId,
  );
  if (!session || session.owner_address.toLowerCase() !== input.ownerAddress.toLowerCase()) {
    throw new Error("AUTH_CAPABILITY_SESSION_OWNER");
  }
  if (session.state !== "ACTIVE" || session.expires_at <= Date.now()) {
    throw new Error("INVALID_CAPABILITY_SESSION_STATE");
  }
  const challenge = await deriveCapabilityChallenge(
    session.id,
    session.owner_address,
    session.track,
  );
  if (challenge.commitment !== session.challenge_commitment) {
    throw new Error("INVALID_CAPABILITY_COMMITMENT");
  }
  const passed = stableJson(input.answer) === stableJson(challenge.expectedAnswer);
  const now = Date.now();
  const submissionHash = v41Hash({
    sessionId: input.sessionId,
    answer: input.answer,
  });
  await executeBatch([
    {
      sql: `UPDATE v41_capability_sessions
            SET submission_hash = ?, score_bps = ?, latency_ms = ?,
                state = ?, submitted_at = ?
            WHERE id = ? AND state = 'ACTIVE'`,
      bindings: [
        submissionHash,
        passed ? 10_000 : 0,
        input.latencyMs,
        passed ? "PASSED" : "FAILED",
        now,
        input.sessionId,
      ],
    },
    {
      sql: `UPDATE v41_execution_profiles
            SET conservative_success_bps = CASE
                  WHEN ? = 1 THEN MIN(9500, conservative_success_bps + 2500)
                  ELSE MAX(0, conservative_success_bps - 3000)
                END,
                p50_latency_ms = CASE WHEN p50_latency_ms = 0 THEN ? ELSE (p50_latency_ms + ?) / 2 END,
                p95_latency_ms = MAX(p95_latency_ms, ?),
                reproducible_results = reproducible_results + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
                updated_at = ?
            WHERE id = ?`,
      bindings: [
        passed ? 1 : 0,
        input.latencyMs,
        input.latencyMs,
        input.latencyMs,
        passed ? 1 : 0,
        now,
        session.profile_id,
      ],
    },
  ]);
  return {
    sessionId: input.sessionId,
    passed,
    scoreBps: passed ? 10_000 : 0,
    latencyMs: input.latencyMs,
    submissionHash,
    rewardApool: passed ? session.reward_apool : "0",
    rewardStatus: passed
      ? "PROOF_RECORDED_V41_CHAIN_PENDING"
      : "NOT_ELIGIBLE",
    note:
      "Capability evidence is recorded offchain. A catalog-admitted objective EpochVault assignment is still required before any tAPOOL can mint.",
  };
}

export async function v41Status(): Promise<Record<string, unknown>> {
  await ensureV41Seed();
  const [opportunities, profiles, assignments, artifacts, chain] = await Promise.all([
    queryFirst<{ count: number }>("SELECT COUNT(*) AS count FROM v41_opportunities"),
    queryFirst<{ count: number }>("SELECT COUNT(*) AS count FROM v41_execution_profiles"),
    queryFirst<{ count: number }>("SELECT COUNT(*) AS count FROM v41_assignments"),
    queryFirst<{ count: number }>("SELECT COUNT(*) AS count FROM v41_artifacts"),
    v41ChainStatus().catch(() => null),
  ]);
  return {
    ...V41,
    deployment: {
      legacyV3Live: true,
      v41ContractsCompiled: true,
      v41LocalSettlementVerified: true,
      localRehearsalTransactions: 24,
      localRehearsalChecks: 9,
      economySimulationVerified: true,
      v41BaseSepoliaDeployed: true,
      contractsVerified: true,
      deploymentVerificationChecks: 34,
      postSmokeVerificationChecks: 40,
      onchainSettlement: true,
      gatewayOnchainWrites: false,
      gatewayWriteStatus: "RECEIPT_BRIDGE_READY",
      receiptStateBridge: true,
      unsignedTransactionBuilders: true,
      catalogAdmissionAutomation: false,
      firstSettlementSmokePassed: V41_SMOKE.ok,
      firstSettlementAssignmentId: V41_SMOKE.assignmentId,
      firstSettlementTransactions: V41_SMOKE.transactionHashes,
      firstSettlementChecks: V41_SMOKE.checks,
      deployerHasRuntimeAuthority: false,
      chainId: V41_DEPLOYMENT.chainId,
      genesisStart: V41_DEPLOYMENT.genesisStart,
      catalogQuorum: V41_DEPLOYMENT.catalogQuorum,
      addresses: V41_DEPLOYMENT.contracts,
      deploymentTransactions: V41_DEPLOYMENT.transactionHashes,
      rpcAvailable: chain !== null,
      chain,
    },
    gateway: {
      opportunities: opportunities?.count ?? 0,
      executionProfiles: profiles?.count ?? 0,
      assignments: assignments?.count ?? 0,
      provenArtifacts: artifacts?.count ?? 0,
      chainConfirmationEndpoint: "/api/v4.1/chain/confirm",
      serverCustodiesKeys: false,
    },
  };
}
