import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseEther,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const chainId = Number(process.env.AGENTPOOL_CHAIN_ID ?? "84532");
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : null;
if (!chain) throw new Error("AGENTPOOL_CHAIN_ID must be 84532 or 8453");

if (chainId === 8453) {
  const gates = JSON.parse(
    fs.readFileSync(path.join(root, "mainnet-gates.json"), "utf8"),
  );
  const evidenceMap = [
    ["smartContractAudit", "MAINNET_AUDIT_REPORT_SHA256"],
    ["koreaLegalReview", "MAINNET_LEGAL_MEMO_SHA256"],
    ["trademarkClearance", "MAINNET_TRADEMARK_EVIDENCE_SHA256"],
    ["testnetReliability", "MAINNET_TESTNET_REPORT_SHA256"],
    ["multisigAndTimelock", "MAINNET_MULTISIG_EVIDENCE_SHA256"],
  ];
  for (const [gateName, envName] of evidenceMap) {
    const gate = gates.gates[gateName];
    if (
      gate.status !== "approved" ||
      !gate.evidenceSha256 ||
      requireEnv(envName) !== gate.evidenceSha256
    ) {
      throw new Error(`MAINNET_BLOCKED: ${gateName}`);
    }
  }
}

const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const roleNames = [
  "OPERATOR_WALLET",
  "ECOSYSTEM_TREASURY",
  "LIQUIDITY_TREASURY",
  "SECURITY_TREASURY",
  "PROTOCOL_TREASURY",
  "EVALUATOR_TREASURY",
  "MINING_ROOT_PUBLISHER",
];
const roles = roleNames.map((name) => getAddress(requireEnv(name)));
if (new Set(roles.map((address) => address.toLowerCase())).size !== roles.length) {
  throw new Error("All operating role addresses must be distinct");
}
if (roles.some((address) => address.toLowerCase() === account.address.toLowerCase())) {
  throw new Error("Deployer must be distinct from every operating role");
}

const genesis = BigInt(requireEnv("MINING_GENESIS_TIMESTAMP"));
if (genesis <= 0n) throw new Error("MINING_GENESIS_TIMESTAMP must be positive");
const siteUrl = new URL(requireEnv("PUBLIC_SITE_URL"));
if (siteUrl.protocol !== "https:") {
  throw new Error("PUBLIC_SITE_URL must use HTTPS");
}

const requiredArtifacts = [
  "AgentPoolToken",
  "TimelockController",
  "AgentPoolGovernor",
  "AgentPoolRegistry",
  "AgentPoolLicense",
  "AgentPoolWorkOracle",
  "AgentPoolJobEscrow",
  "AgentPoolMiningVault",
  ...(chainId === 8453 ? [] : ["MockRandomnessProvider"]),
];
const artifactHashes = {};
for (const name of requiredArtifacts) {
  const artifact = JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`Missing bytecode for ${name}`);
  }
  artifactHashes[name] = keccak256(artifact.bytecode);
}

const schedule = JSON.parse(
  fs.readFileSync(path.join(root, "mining-schedule.json"), "utf8"),
);
const miningTotal = schedule.budgetsWei.map(BigInt).reduce((sum, value) => sum + value, 0n);
if (
  schedule.epochs !== 520 ||
  schedule.budgetsWei.length !== 520 ||
  miningTotal !== parseEther("500000000")
) {
  throw new Error("Mining schedule invariant failed");
}

const client = createPublicClient({ chain, transport: http(rpcUrl) });
const connectedChainId = await client.getChainId();
if (connectedChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
}
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_DEPLOYER_BALANCE_WEI ?? parseEther("0.01").toString(),
);
if (balance < minimumBalance) {
  throw new Error(`DEPLOYER_BALANCE_TOO_LOW: ${balance} < ${minimumBalance}`);
}

if (chainId === 8453) {
  const vrf = getAddress(requireEnv("CHAINLINK_VRF_ADAPTER"));
  const code = await client.getCode({ address: vrf });
  if (!code || code === "0x") throw new Error("MAINNET_BLOCKED: VRF adapter has no code");
}

console.log(JSON.stringify({
  status: "ready",
  chainId,
  network: chain.name,
  deployer: account.address,
  balanceWei: balance.toString(),
  minimumBalanceWei: minimumBalance.toString(),
  genesis: genesis.toString(),
  publicSiteUrl: siteUrl.origin,
  miningTotalWei: miningTotal.toString(),
  artifactHashes,
}, null, 2));
