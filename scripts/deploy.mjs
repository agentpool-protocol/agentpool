import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const chainId = Number(process.env.AGENTPOOL_CHAIN_ID ?? "84532");
const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : null;
if (!chain) throw new Error("AGENTPOOL_CHAIN_ID must be 84532 or 8453");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (chainId === 8453) {
  const gates = JSON.parse(fs.readFileSync(path.join(root, "mainnet-gates.json"), "utf8"));
  const incomplete = Object.entries(gates.gates)
    .filter(([, gate]) => gate.status !== "approved" || !gate.evidenceSha256)
    .map(([name]) => name);
  if (incomplete.length > 0) {
    throw new Error(`MAINNET_BLOCKED: incomplete gates: ${incomplete.join(", ")}`);
  }
  for (const [gateName, envName] of [
    ["smartContractAudit", "MAINNET_AUDIT_REPORT_SHA256"],
    ["koreaLegalReview", "MAINNET_LEGAL_MEMO_SHA256"],
    ["trademarkClearance", "MAINNET_TRADEMARK_EVIDENCE_SHA256"],
    ["testnetReliability", "MAINNET_TESTNET_REPORT_SHA256"],
    ["multisigAndTimelock", "MAINNET_MULTISIG_EVIDENCE_SHA256"],
  ]) {
    if (requireEnv(envName) !== gates.gates[gateName].evidenceSha256) {
      throw new Error(`MAINNET_BLOCKED: evidence mismatch for ${gateName}`);
    }
  }
}

const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const transport = http(requireEnv("AGENTPOOL_RPC_URL"));
const wallet = createWalletClient({ account, chain, transport });
const publicClient = createPublicClient({ chain, transport });

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"));
}

async function deploy(name, args = []) {
  const compiled = artifact(name);
  const hash = await wallet.deployContract({
    account,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name} deployment failed: ${hash}`);
  }
  console.log(`${name}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const miningReserve = account.address;
const operatorWallet = requireEnv("OPERATOR_WALLET");
const ecosystemTreasury = requireEnv("ECOSYSTEM_TREASURY");
const liquidityTreasury = requireEnv("LIQUIDITY_TREASURY");
const securityTreasury = requireEnv("SECURITY_TREASURY");
const protocolTreasury = requireEnv("PROTOCOL_TREASURY");
const evaluatorTreasury = requireEnv("EVALUATOR_TREASURY");
const rootPublisher = requireEnv("MINING_ROOT_PUBLISHER");
const genesis = BigInt(requireEnv("MINING_GENESIS_TIMESTAMP"));
const publicSiteUrl = requireEnv("PUBLIC_SITE_URL").replace(/\/$/u, "");

const token = await deploy("AgentPoolToken", [
  miningReserve,
  operatorWallet,
  ecosystemTreasury,
  liquidityTreasury,
  securityTreasury,
]);
const timelock = await deploy("TimelockController", [
  7n * 24n * 60n * 60n,
  [account.address],
  [zeroAddress],
  account.address,
]);
const governor = await deploy("AgentPoolGovernor", [token, timelock]);
const registry = await deploy("AgentPoolRegistry", [account.address]);
const license = await deploy("AgentPoolLicense", [
  account.address,
  `${publicSiteUrl}/api/v1/licenses/{id}.json`,
]);
let randomnessProvider;
if (chainId === 84532) {
  randomnessProvider = await deploy("MockRandomnessProvider");
} else {
  randomnessProvider = requireEnv("CHAINLINK_VRF_ADAPTER");
  if (randomnessProvider.toLowerCase().includes("mock")) {
    throw new Error("MAINNET_BLOCKED: mock randomness provider");
  }
}
const oracle = await deploy("AgentPoolWorkOracle", [
  account.address,
  randomnessProvider,
  evaluatorTreasury,
]);
const escrow = await deploy("AgentPoolJobEscrow", [
  token,
  account.address,
  protocolTreasury,
  securityTreasury,
]);
const miningVault = await deploy("AgentPoolMiningVault", [
  token,
  account.address,
  rootPublisher,
  genesis,
]);

async function write(name, address, functionName, args = []) {
  const compiled = artifact(name);
  const hash = await wallet.writeContract({
    account,
    address,
    abi: compiled.abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name}.${functionName} failed: ${hash}`);
  return hash;
}

if (chainId === 84532) {
  await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
}
await write("AgentPoolWorkOracle", oracle, "setEscrow", [escrow]);
await write("AgentPoolJobEscrow", escrow, "setResolver", [oracle]);

const schedule = JSON.parse(fs.readFileSync(path.join(root, "mining-schedule.json"), "utf8"));
for (let start = 0; start < schedule.budgetsWei.length; start += 20) {
  const chunk = schedule.budgetsWei.slice(start, start + 20).map(BigInt);
  await write("AgentPoolMiningVault", miningVault, "configureEpochs", [start, chunk]);
}

const tokenArtifact = artifact("AgentPoolToken");
const transferHash = await wallet.writeContract({
  account,
  address: token,
  abi: tokenArtifact.abi,
  functionName: "transfer",
  args: [miningVault, parseEther("500000000")],
});
await publicClient.waitForTransactionReceipt({ hash: transferHash });

for (const [name, address] of [
  ["AgentPoolRegistry", registry],
  ["AgentPoolLicense", license],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
]) {
  await write(name, address, "transferOwnership", [timelock]);
}

const proposerRole = keccak256(toBytes("PROPOSER_ROLE"));
const cancellerRole = keccak256(toBytes("CANCELLER_ROLE"));
const adminRole = zeroHash;
await write("TimelockController", timelock, "grantRole", [proposerRole, governor]);
await write("TimelockController", timelock, "grantRole", [cancellerRole, governor]);
await write("TimelockController", timelock, "revokeRole", [proposerRole, account.address]);
await write("TimelockController", timelock, "revokeRole", [cancellerRole, account.address]);
await write("TimelockController", timelock, "revokeRole", [adminRole, account.address]);

const deployment = {
  version: 1,
  chainId,
  network: chain.name,
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  contracts: {
    token,
    timelock,
    governor,
    registry,
    license,
    randomnessProvider,
    oracle,
    escrow,
    miningVault,
  },
};
const target = path.join(root, "deployments", `${chainId}.json`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Deployment manifest: ${target}`);
