import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";

const root = process.cwd();
const deploymentPath = path.join(root, "deployments", "84532.v42.json");
const deployment = fs.existsSync(deploymentPath)
  ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
  : null;
const contracts = [
  "AgentPoolV42Token",
  "AgentPoolV42ImprovementKernel",
  "AgentPoolV42HashImprovementVerifier",
  "AgentPoolV42UserEscrow",
  "AgentPoolV41HashVerifier",
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

const manifest = {
  schema: "https://agentpool.org/schemas/release-manifest-v1.json",
  protocol: "AgentPool",
  release: "4.2.0-alpha",
  authority: "onchain-bytecode-and-content-hashes",
  status: deployment ? "base-sepolia-alpha" : "local-rehearsal-only",
  generatedAt: new Date().toISOString(),
  sourceMirrors: [
    "https://github.com/agentpool-protocol/agentpool",
  ],
  websiteRequired: false,
  network: {
    name: "Base Sepolia",
    chainId: 84532,
    rpcHint: "https://sepolia.base.org",
    deployment: deployment
      ? {
          manifest: "deployments/84532.v42.json",
          contracts: deployment.contracts,
          deploymentBlock: deployment.deploymentBlock,
        }
      : null,
  },
  economy: {
    token: "tAPOOL",
    maxSupply: "1000000000000",
    decimals: 18,
    premint: "0",
    emissionSources: ["PROVEN_AGENTPOOL_IMPROVEMENT"],
    removedEmissionSources: [
      "BASIC_MINING",
      "BENCHMARK_FAUCET",
      "CAPABILITY_MEASUREMENT_FAUCET",
      "TRAFFIC",
      "TOKEN_TRADING",
      "EXTERNAL_BUYER_JOB",
    ],
    externalJobsMint: false,
    fixedRolePercentages: false,
    fixedValidationFee: false,
  },
  improvementFlow: [
    "ISSUE_EVIDENCE",
    "INDEPENDENT_REPRODUCTION",
    "BUDGET_RESERVATION",
    "CANDIDATE_REVERSE_AUCTION",
    "OBJECTIVE_CANARY_PROOF",
    "ODD_COMMIT_REVEAL_PANEL",
    "PROVEN",
    "SLASH_REUSE_THEN_CAPPED_EMISSION",
  ],
  artifacts,
  machineInterfaces: {
    localMcp: {
      command: "node",
      args: ["mcp/agentpool-v42.mjs"],
      transport: "stdio",
      walletCustody: "local-only",
    },
    rehearsal: "npm run contracts:rehearse:v4.2",
    protocolDocument: "V42_IMPROVEMENT_ONLY.md",
  },
  warnings: [
    "Base Sepolia tAPOOL has no promised value.",
    "Never send mainnet assets to a generated test wallet.",
    "A source mirror or website is not protocol authority.",
    "Actual-value deployment remains blocked on a bonded challenge market.",
  ],
};

const output = path.join(root, "protocol", "agentpool-v42.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    status: manifest.status,
    output,
    artifacts: contracts.length,
  })}\n`,
);
