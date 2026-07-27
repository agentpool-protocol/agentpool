import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath =
  process.env.V43_DEPLOYMENT_MANIFEST ??
  path.join(root, "deployments", "84532.v43.4.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (
  manifest.chainId !== 84532 ||
  manifest.version !== "4.3.4-bootstrap-alpha"
) {
  throw new Error("V43_MANIFEST_INVALID");
}
const rpcUrl = process.env.AGENTPOOL_RPC_URL;
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL_MISSING");
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
if ((await client.getChainId()) !== 84532) throw new Error("V43_CHAIN_MISMATCH");

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}
async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}

const contractTypes = {
  token: "AgentPoolV43Token",
  userEscrow: "AgentPoolV43UserEscrowKernel",
  coreEpochVault: "AgentPoolV43EpochVault",
  evolutionEpochVault: "AgentPoolV43EpochVault",
  contributionLedger: "AgentPoolV43ContributionLedger",
  evolutionConsensus: "AgentPoolV43EvolutionConsensus",
  releaseRegistry: "AgentPoolV43ReleaseRegistry",
  taskMarket: "AgentPoolV432TaskMarket",
  capacityRegistry: "AgentPoolV43CapacityRegistry",
  proofRegistry: "AgentPoolV432ProofRegistry",
  settlementRouter: "AgentPoolV43SettlementRouter",
  objectiveVerifier: "AgentPoolV43HashObjectiveVerifier",
  systemIssueGate: "AgentPoolV432SystemIssueGate",
  issueConsensus: "AgentPoolV432IssueConsensus",
};
const checks = [];
function check(name, actual, expected) {
  const passed =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: typeof actual === "bigint" ? actual.toString() : actual,
    expected: typeof expected === "bigint" ? expected.toString() : expected,
  });
}

const codeHashes = {};
for (const [key, type] of Object.entries(contractTypes)) {
  const address = manifest.contracts[key];
  const code = await client.getCode({ address });
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") {
    check(`codeSize:${key}`, (code.length - 2) / 2 <= 24_576, true);
    codeHashes[key] = keccak256(code);
  }
  artifact(type);
}
const zero = "0x0000000000000000000000000000000000000000";
check(
  "token.configurationAuthorityRemoved",
  await read("AgentPoolV43Token", manifest.contracts.token, "configurationAuthority"),
  zero,
);
check(
  "escrow.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
    "configurationAuthority",
  ),
  zero,
);
check(
  "coreVault.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43EpochVault",
    manifest.contracts.coreEpochVault,
    "configurationAuthority",
  ),
  zero,
);
check(
  "evolutionVault.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43EpochVault",
    manifest.contracts.evolutionEpochVault,
    "configurationAuthority",
  ),
  zero,
);
check(
  "ledger.bootstrapAuthorityRemoved",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "bootstrapAuthority",
  ),
  zero,
);
check(
  "registry.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "configurationAuthority",
  ),
  zero,
);
check(
  "capacity.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43CapacityRegistry",
    manifest.contracts.capacityRegistry,
    "configurationAuthority",
  ),
  zero,
);
check(
  "proof.configurationAuthorityRemoved",
  await read(
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
    "configurationAuthority",
  ),
  zero,
);
check(
  "router.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "configurationAuthority",
  ),
  zero,
);
check(
  "issueGate.configurationAuthorityRemoved",
  await read(
    "AgentPoolV432SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "configurationAuthority",
  ),
  zero,
);
check(
  "issueGate.market",
  await read(
    "AgentPoolV432SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "market",
  ),
  manifest.contracts.taskMarket,
);
check(
  "issueGate.consensus",
  await read(
    "AgentPoolV432SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "consensus",
  ),
  manifest.contracts.issueConsensus,
);
check(
  "issueGate.bootstrapRoot",
  await read(
    "AgentPoolV432SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "bootstrapRoot",
  ),
  manifest.bootstrapIssueRoot,
);
check(
  "token.coreMinter",
  await read("AgentPoolV43Token", manifest.contracts.token, "coreEpochVault"),
  manifest.contracts.coreEpochVault,
);
check(
  "token.evolutionMinter",
  await read("AgentPoolV43Token", manifest.contracts.token, "evolutionEpochVault"),
  manifest.contracts.evolutionEpochVault,
);
check(
  "token.bootstrapSupplyBounded",
  (await read(
    "AgentPoolV43Token",
    manifest.contracts.token,
    "totalSupply",
  )) <= parseEther("120"),
  true,
);
check(
  "token.maxSupply",
  await read("AgentPoolV43Token", manifest.contracts.token, "MAX_SUPPLY"),
  parseEther("1000000000000"),
);
check(
  "ledger.bootstrapPhase",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "mature",
  ),
  false,
);
check(
  "ledger.activeSettlementRouter",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "isActiveSource",
    [manifest.contracts.settlementRouter],
  ),
  true,
);
check(
  "registry.genesisRecommendation",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "recommendedRelease",
  ),
  manifest.genesisRelease,
);
check(
  "taskMarket.financeInvariant",
  await read(
    "AgentPoolV432TaskMarket",
    manifest.contracts.taskMarket,
    "financeInvariantHash",
  ),
  manifest.financeInvariantHash,
);

for (const [index, hash] of manifest.transactionHashes.entries()) {
  const receipt = await client.getTransactionReceipt({ hash });
  check(`deployment.transaction:${index + 1}`, receipt.status, "success");
}

const report = {
  ok: checks.every((entry) => entry.passed),
  chainId: 84532,
  phase: "BOOTSTRAP",
  manifestPath,
  codeHashes,
  checks,
  verifiedAt: new Date().toISOString(),
};
const reportPath = path.join(root, "outputs", "v43-base-sepolia-verification.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) throw new Error(`V43_VERIFICATION_FAILED:${reportPath}`);
process.stdout.write(
  `${JSON.stringify({ ok: true, checks: checks.length, reportPath })}\n`,
);
