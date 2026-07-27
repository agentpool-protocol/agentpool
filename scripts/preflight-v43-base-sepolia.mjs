import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const expectedChainId = 84532;
const requiredArtifacts = [
  "AgentPoolV43Token",
  "AgentPoolV43UserEscrowKernel",
  "AgentPoolV43EpochVault",
  "AgentPoolV43ContributionLedger",
  "AgentPoolV43EvolutionConsensus",
  "AgentPoolV43ReleaseRegistry",
  "AgentPoolV432TaskMarket",
  "AgentPoolV43CapacityRegistry",
  "AgentPoolV432ProofRegistry",
  "AgentPoolV43SettlementRouter",
  "AgentPoolV43HashObjectiveVerifier",
  "AgentPoolV432SystemIssueGate",
  "AgentPoolV432IssueConsensus",
];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const privateKey = requireEnv("DEPLOYER_PRIVATE_KEY");
if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
  throw new Error("DEPLOYER_PRIVATE_KEY_INVALID");
}
const account = privateKeyToAccount(privateKey);
const bootstrapValidators = [
  "VALIDATOR_1",
  "VALIDATOR_2",
  "VALIDATOR_3",
].map((name) => {
  const value = requireEnv(name);
  if (!isAddress(value)) throw new Error(`${name}_INVALID`);
  return getAddress(value);
});
if (
  new Set(bootstrapValidators.map((address) => address.toLowerCase()))
    .size !== bootstrapValidators.length
) {
  throw new Error("V432_BOOTSTRAP_VALIDATORS_NOT_DISTINCT");
}
const manifestPath = path.join(root, "deployments", "84532.v43.4.json");
if (fs.existsSync(manifestPath)) throw new Error("V43_ALREADY_DEPLOYED");

const artifactHashes = {};
const runtimeSizes = {};
for (const name of requiredArtifacts) {
  const artifactPath = path.join(root, "artifacts", `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`V43_ARTIFACT_MISSING:${name}`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (
    !/^0x[a-fA-F0-9]+$/.test(artifact.bytecode ?? "") ||
    !/^0x[a-fA-F0-9]+$/.test(artifact.deployedBytecode ?? "")
  ) {
    throw new Error(`V43_ARTIFACT_BYTECODE_INVALID:${name}`);
  }
  const runtimeSize = (artifact.deployedBytecode.length - 2) / 2;
  if (runtimeSize > 24_576) {
    throw new Error(`V43_RUNTIME_TOO_LARGE:${name}:${runtimeSize}`);
  }
  artifactHashes[name] = keccak256(artifact.bytecode);
  runtimeSizes[name] = runtimeSize;
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const chainId = await client.getChainId();
if (chainId !== expectedChainId) throw new Error("V43_CHAIN_MISMATCH");
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V43_DEPLOYER_BALANCE_WEI ?? "100000000000000",
);
if (balance < minimumBalance) {
  throw new Error(
    `V43_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
  );
}

const partialPath = path.join(root, "deployments", "84532.v43.4.partial.json");
const partial = fs.existsSync(partialPath)
  ? JSON.parse(fs.readFileSync(partialPath, "utf8"))
  : null;
if (partial && partial.deployer?.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error("V43_PARTIAL_DEPLOYER_MISMATCH");
}

process.stdout.write(
  `${JSON.stringify({
    ready: true,
    network: "Base Sepolia",
    chainId,
    deployer: account.address,
    bootstrapValidators,
    deployerTestEth: formatEther(balance),
    minimumBalanceWei: minimumBalance.toString(),
    resumablePartial: Boolean(partial),
    artifactHashes,
    runtimeSizes,
    writesPerformed: false,
  })}\n`,
);
