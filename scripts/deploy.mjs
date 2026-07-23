import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
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

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : null;
if (!chain) {
  throw new Error("AGENTPOOL_CHAIN_ID must be 84532 or 8453");
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
const transport = http(rpcUrl);
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
const operatorWallet = getAddress(requireEnv("OPERATOR_WALLET"));
const ecosystemTreasury = getAddress(requireEnv("ECOSYSTEM_TREASURY"));
const liquidityTreasury = getAddress(requireEnv("LIQUIDITY_TREASURY"));
const securityTreasury = getAddress(requireEnv("SECURITY_TREASURY"));
const evaluatorTreasury = getAddress(requireEnv("EVALUATOR_TREASURY"));
const rootPublisher = getAddress(requireEnv("MINING_ROOT_PUBLISHER"));
const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const initialVerifierNames = protocolConfig.bootstrapVerifierNames;
if (
  !Array.isArray(initialVerifierNames) ||
  initialVerifierNames.length === 0 ||
  initialVerifierNames.some((name) => !/^[a-z0-9][a-z0-9-]{2,79}$/u.test(name)) ||
  new Set(initialVerifierNames).size !== initialVerifierNames.length
) {
  throw new Error("protocol-config.json contains invalid bootstrapVerifierNames");
}
const initialVerifierIds = initialVerifierNames.map((name) => keccak256(toBytes(name)));
const initialVerifierAdapter = getAddress(requireEnv("INITIAL_VERIFIER_ADAPTER"));
const initialVerifierImplementationHash = requireEnv("INITIAL_VERIFIER_IMPLEMENTATION_HASH");
const evaluators = Array.from({ length: 5 }, (_, index) =>
  getAddress(requireEnv(`EVALUATOR_${index + 1}`)),
);
const genesis = BigInt(requireEnv("MINING_GENESIS_TIMESTAMP"));
const publicSiteUrl = requireEnv("PUBLIC_SITE_URL").replace(/\/$/u, "");
new URL(publicSiteUrl);
for (const [label, value] of [
  ["INITIAL_VERIFIER_IMPLEMENTATION_HASH", initialVerifierImplementationHash],
]) {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value) || /^0x0{64}$/u.test(value)) {
    throw new Error(`${label} must be a nonzero bytes32 hex value`);
  }
}

const roleAddresses = [
  operatorWallet,
  ecosystemTreasury,
  liquidityTreasury,
  securityTreasury,
  evaluatorTreasury,
  rootPublisher,
  initialVerifierAdapter,
  ...evaluators,
];
if (new Set(roleAddresses.map((address) => address.toLowerCase())).size !== roleAddresses.length) {
  throw new Error("Operator, treasury, evaluator, and publisher addresses must be distinct");
}
if (roleAddresses.some((address) => address.toLowerCase() === account.address.toLowerCase())) {
  throw new Error("The temporary deployer/mining reserve must not also hold an operating role");
}

const connectedChainId = await publicClient.getChainId();
if (connectedChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
}
const deployerBalance = await publicClient.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_DEPLOYER_BALANCE_WEI ?? parseEther("0.01").toString(),
);
if (deployerBalance < minimumBalance) {
  throw new Error(
    `DEPLOYER_BALANCE_TOO_LOW: ${deployerBalance} wei; minimum ${minimumBalance} wei`,
  );
}
console.log(
  `Preflight OK: ${chain.name} (${chainId}), deployer ${account.address}, balance ${deployerBalance} wei`,
);

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
  `${publicSiteUrl}/api/v1/licenses/{id}.json`,
]);
let randomnessProvider;
if (chainId === 84532) {
  randomnessProvider = await deploy("MockRandomnessProvider", [account.address]);
} else {
  randomnessProvider = getAddress(requireEnv("CHAINLINK_VRF_ADAPTER"));
  const providerCode = await publicClient.getCode({ address: randomnessProvider });
  if (!providerCode || providerCode === "0x") {
    throw new Error("MAINNET_BLOCKED: VRF adapter has no deployed bytecode");
  }
}
const oracle = await deploy("AgentPoolWorkOracle", [
  account.address,
  registry,
  randomnessProvider,
  evaluatorTreasury,
]);
const escrow = await deploy("AgentPoolJobEscrow", [
  token,
  registry,
  account.address,
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
for (const verifierId of initialVerifierIds) {
  await write("AgentPoolRegistry", registry, "configureVerifier", [
    verifierId,
    initialVerifierAdapter,
    initialVerifierImplementationHash,
    true,
    true,
  ]);
}
for (const evaluator of evaluators) {
  await write("AgentPoolWorkOracle", oracle, "setEvaluator", [evaluator, true]);
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
const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
if (transferReceipt.status !== "success") {
  throw new Error(`Funding mining vault failed: ${transferHash}`);
}

for (const [name, address] of [
  ["AgentPoolRegistry", registry],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
  ...(chainId === 84532
    ? [["MockRandomnessProvider", randomnessProvider]]
    : []),
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
  bootstrap: {
    verifiers: initialVerifierNames.map((name, index) => ({
      name,
      id: initialVerifierIds[index],
    })),
    verifierAdapter: initialVerifierAdapter,
    verifierImplementationHash: initialVerifierImplementationHash,
    evaluators,
  },
};
const target = path.join(root, "deployments", `${chainId}.json`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Deployment manifest: ${target}`);
