import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";

const root = process.cwd();
const deploymentPath = path.join(root, "deployments", "84532.v43.5.json");
const deployment = fs.existsSync(deploymentPath)
  ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
  : null;
const contracts = [
  "AgentPoolV43ContributionLedger",
  "AgentPoolV43EvolutionConsensus",
  "AgentPoolV432IssueConsensus",
  "AgentPoolV435SystemIssueGate",
  "AgentPoolV435TransitionIssueConsensus",
  "AgentPoolV432TaskMarket",
  "AgentPoolV43Token",
  "AgentPoolV43EpochVault",
  "AgentPoolV43UserEscrowKernel",
  "AgentPoolV43ReleaseRegistry",
  "AgentPoolV43CapacityRegistry",
  "AgentPoolV432ProofRegistry",
  "AgentPoolV43SettlementRouter",
  "AgentPoolV43HashObjectiveVerifier",
];

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

const artifacts = Object.fromEntries(
  contracts.map((name) => {
    const file = path.join(root, "artifacts", `${name}.json`);
    const raw = fs.readFileSync(file);
    const artifact = JSON.parse(raw);
    return [
      name,
      {
        source: artifact.sourceName,
        artifactSha256: sha256(raw),
        runtimeCodeHash: keccak256(artifact.deployedBytecode),
      },
    ];
  }),
);

const financeInvariantHash =
  deployment?.financeInvariantHash ??
  keccak256(
    new TextEncoder().encode(
      "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout|receipt-replay",
    ),
  );
const rehearsalPath = path.join(
  root,
  "outputs",
  "v43-public-testnet-rehearsal.json",
);
const rehearsal = fs.existsSync(rehearsalPath)
  ? JSON.parse(fs.readFileSync(rehearsalPath, "utf8"))
  : null;
const smokePath = path.join(
  root,
  "deployments",
  "84532.v43.5.smoke.json",
);
const smoke = fs.existsSync(smokePath)
  ? JSON.parse(fs.readFileSync(smokePath, "utf8"))
  : null;

const manifest = {
  schema: "https://agentpool.org/schemas/release-manifest-v1.json",
  protocol: "AgentPool",
  release: deployment?.version ?? "4.3.5-staged-autonomy-alpha",
  authority: "versioned-bytecode-content-hashes-and-proof-of-contribution",
  status: deployment ? "base-sepolia-alpha" : "local-rehearsal-only",
  generatedAt: new Date().toISOString(),
  financeInvariantHash,
  sourceMirrors: ["https://github.com/agentpool-protocol/agentpool"],
  websiteRequired: false,
  network: {
    name: "Base Sepolia",
    chainId: 84532,
    deployment: deployment
      ? {
          manifest: "deployments/84532.v43.5.json",
          contracts: deployment.contracts,
          deployedAt: deployment.deployedAt,
        }
      : null,
  },
  markets: {
    emission: ["PROVEN_AGENTPOOL_SYSTEM_IMPROVEMENT"],
    existingToken: ["EXTERNAL_BUYER_WORK"],
    removed: [
      "BASIC_MINING",
      "CAPABILITY_FAUCET",
      "BENCHMARK_FAUCET",
      "TRAFFIC",
      "DOWNLOADS",
      "TOKEN_TRADING",
    ],
  },
  goal: {
    northStar:
      "Build an ownerless Base Sepolia AI production economy where MCP-capable agents discover paid external work and AgentPool improvement work, divide it into safe dependency graphs, compete on price and measured reliability, execute and validate independently, receive deterministic tAPOOL settlement, and continuously improve versioned modules without any single AI being able to rewrite active jobs or finance invariants.",
    outcome:
      "Any MCP-capable AI can discover Base Sepolia work, create or use a device-local test wallet, compete on a finite system-improvement Issue or buyer-funded job, submit evidence, and receive deterministic onchain settlement without a permanent owner.",
    bootstrapOutcome:
      "Before five proven AIs and three independent operator groups exist, buyer-funded external work and buyer-funded AgentPool improvement work remain open, opt-in PROVEN releases may accumulate, no new system emission or recommended-release change is possible after the finite genesis Issue is consumed, and running work remains pinned to its release.",
    matureOutcome:
      "After the immutable participation thresholds are reached automatically, verified recent work becomes capped Work Power: new system Issues and recommended-release changes require at least five AIs, three groups, thirty-percent quorum, and two-thirds support.",
    preMainnetCompletion: [
      "OWNERLESS_BASE_SEPOLIA_KERNEL",
      "FINITE_BOOTSTRAP_ISSUES",
      "MATURE_WORK_POWER_ISSUE_CONSENSUS",
      "EXTERNAL_JOB_ZERO_EMISSION",
      "DEVICE_LOCAL_WALLET_MCP",
      "PUBLIC_CHAIN_EXPLORER",
      "ADVERSARIAL_ECONOMIC_TESTS",
      "NO_BASE_MAINNET_OR_REAL_ASSETS",
    ],
  },
  autonomousFlow: [
    "OPPORTUNITY_DISCOVERY",
    "REWARD_QUOTE_MARKET",
    "DAG_PLAN_MARKET",
    "RISK_ADJUSTED_ROLE_AUCTION",
    "BUDGET_AND_CAPACITY_RESERVATION",
    "EXECUTION_AND_SUBCONTRACTING",
    "EVIDENCE_ONLY_EVALUATION",
    "DETERMINISTIC_SETTLEMENT",
    "CONTRIBUTION_UPDATE",
    "REINVESTMENT",
  ],
  evolution: {
    weight: "verified-recent-work-times-reliability",
    perAgentCapBps: 1000,
    quorumBps: 3000,
    supermajorityBps: 6667,
    minimumVoters: 5,
    minimumOperatorGroups: 3,
    minimumIndependentAdoptions: 5,
    minimumAdoptionGroups: 3,
    runningJobsRemainPinned: true,
    singleAgentUpgrade: false,
  },
  immutableFinance: [
    "MAXIMUM_SUPPLY",
    "EXTERNAL_JOB_ZERO_EMISSION",
    "PAYOUT_NEVER_EXCEEDS_RESERVATION",
    "NO_OWNER_WITHDRAWAL",
    "NO_EVALUATOR_PAYOUT_FIELD",
    "RECEIPT_REPLAY_PROTECTION",
  ],
  evolvableModules: [
    "PLANNER",
    "ROUTER",
    "MODEL_ADAPTER",
    "MCP_ADAPTER",
    "VERIFIER",
    "BENCHMARK",
    "INDEXER",
    "EXPLORER",
  ],
  artifacts,
  machineInterfaces: {
    localMcp: {
      command: "node",
      args: ["mcp/agentpool-v43.mjs"],
      transport: "stdio",
      persistentEventLog: true,
      walletCustody: "device-local-test-wallet-or-local-environment-only",
      chainWrites: "Base Sepolia only",
      toolCount: 76,
    },
    sharedCoordinationRelay: {
      endpoint: "/api/v4.3/coordination/events",
      reads: "public-filtered",
      writes: "EIP-191-signed-device-local-wallet",
      authoritativeForFunds: false,
    },
    economicSimulation: "npm run simulate:v4.3",
    onchainRehearsal: "npm run contracts:rehearse:v4.3:public",
    deploymentVerification: "npm run contracts:verify:v4.3",
    economicSmoke: "npm run contracts:smoke:v4.3",
  },
  rehearsal: rehearsal
    ? {
        passed: rehearsal.passed,
        transactionCount: rehearsal.transactionCount,
        checkCount: rehearsal.checks.length,
        recommendedRelease: rehearsal.recommendedRelease,
      }
    : null,
  economicSmoke: smoke
    ? {
        passed: smoke.ok,
        systemJob: smoke.systemJob,
        externalJob: smoke.externalJob,
        totalSupplyApool: smoke.totalSupplyApool,
        checkCount: smoke.checks.length,
      }
    : null,
  warnings: [
    "v4.3.5 is a Base Sepolia testnet alpha. tAPOOL has no promised real-world value.",
    "BOOTSTRAP system emission is finite. Bounded TRANSITION Issues activate only after immutable activity thresholds, and MATURE Issues require stronger Work Power consensus.",
    "The currently deployed v4.1 contracts remain a Legacy Testnet release.",
    "Operator-group diversity is only a cost-raising anti-Sybil layer until independent operators join.",
    "Deployments v4.3 through v4.3.4 are preserved historical test deployments; v4.3.5 is the current public alpha.",
    "Never send mainnet assets to a test wallet.",
  ],
};

const output = path.join(root, "protocol", "agentpool-v43.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    output,
    status: manifest.status,
    artifacts: contracts.length,
  })}\n`,
);
