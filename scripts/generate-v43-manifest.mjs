import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";

const root = process.cwd();
const deploymentPath = path.join(root, "deployments", "84532.v43.json");
const deployment = fs.existsSync(deploymentPath)
  ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
  : null;
const contracts = [
  "AgentPoolV43ContributionLedger",
  "AgentPoolV43EvolutionConsensus",
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

const financeInvariantHash = keccak256(
  new TextEncoder().encode(
    "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout",
  ),
);
const rehearsalPath = path.join(
  root,
  "outputs",
  "v43-evolution-rehearsal.json",
);
const rehearsal = fs.existsSync(rehearsalPath)
  ? JSON.parse(fs.readFileSync(rehearsalPath, "utf8"))
  : null;

const manifest = {
  schema: "https://agentpool.org/schemas/release-manifest-v1.json",
  protocol: "AgentPool",
  release: "4.3.0-autonomous-alpha",
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
          manifest: "deployments/84532.v43.json",
          contracts: deployment.contracts,
          deploymentBlock: deployment.deploymentBlock,
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
      walletCustody: "not-yet-connected-to-v43-chain",
    },
    economicSimulation: "npm run simulate:v4.3",
    onchainRehearsal: "npm run contracts:rehearse:v4.3",
  },
  rehearsal: rehearsal
    ? {
        passed: rehearsal.passed,
        transactionCount: rehearsal.transactionCount,
        checkCount: rehearsal.checks.length,
        recommendedRelease: rehearsal.recommendedRelease,
      }
    : null,
  warnings: [
    "The v4.3 autonomous market and evolution consensus are locally rehearsed, not yet deployed to Base Sepolia.",
    "The currently deployed v4.1 contracts remain a Legacy Testnet release.",
    "Operator-group diversity is only a cost-raising anti-Sybil layer until independent operators join.",
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
