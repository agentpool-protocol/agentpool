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

function validateMainnetGates() {
  if (chainId !== 8453) return;
  const gates = JSON.parse(fs.readFileSync(path.join(root, "mainnet-gates.json"), "utf8"));
  for (const [gateName, envName] of [
    ["smartContractAudit", "MAINNET_AUDIT_REPORT_SHA256"],
    ["koreaLegalReview", "MAINNET_LEGAL_MEMO_SHA256"],
    ["trademarkClearance", "MAINNET_TRADEMARK_EVIDENCE_SHA256"],
    ["testnetReliability", "MAINNET_TESTNET_REPORT_SHA256"],
    ["validatorCollateral", "MAINNET_VALIDATOR_ECONOMICS_SHA256"],
    ["multisigAndTimelock", "MAINNET_MULTISIG_EVIDENCE_SHA256"],
  ]) {
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

validateMainnetGates();
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : null;
if (!chain) throw new Error("AGENTPOOL_CHAIN_ID must be 84532 or 8453");

const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const transport = http(rpcUrl);
const wallet = createWalletClient({ account, chain, transport });
const publicClient = createPublicClient({ chain, transport });

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
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
  if (receipt.status !== "success") {
    throw new Error(`${name}.${functionName} failed: ${hash}`);
  }
  return hash;
}

const governanceMultisig = getAddress(requireEnv("GOVERNANCE_MULTISIG"));
const ecosystemTreasury = getAddress(requireEnv("ECOSYSTEM_TREASURY"));
const operationsTreasury = getAddress(requireEnv("OPERATIONS_TREASURY"));
const validatorTreasury = getAddress(requireEnv("VALIDATOR_TREASURY"));
const authorTreasury = getAddress(requireEnv("AUTHOR_TREASURY"));
const liquidityTreasury = getAddress(requireEnv("LIQUIDITY_TREASURY"));
const founderBeneficiary = getAddress(requireEnv("FOUNDER_BENEFICIARY"));
const securityTreasury = getAddress(requireEnv("SECURITY_TREASURY"));
const initialVerifierAdapter = getAddress(requireEnv("INITIAL_VERIFIER_ADAPTER"));
const validators = Array.from({ length: 5 }, (_, index) =>
  getAddress(requireEnv(`VALIDATOR_${index + 1}`)),
);
const benchmarkGenesis = BigInt(requireEnv("BENCHMARK_GENESIS_TIMESTAMP"));
const founderVestingStart = BigInt(requireEnv("FOUNDER_VESTING_START_TIMESTAMP"));
const benchmarkDailyCap = BigInt(
  process.env.BENCHMARK_DAILY_CAP_APOOL ?? "1000000",
);
const initialPolicyVersion = 1;
const publicSiteUrl = requireEnv("PUBLIC_SITE_URL").replace(/\/$/u, "");
new URL(publicSiteUrl);

const implementationHash = requireEnv("INITIAL_VERIFIER_IMPLEMENTATION_HASH");
if (!/^0x[0-9a-fA-F]{64}$/u.test(implementationHash) || /^0x0{64}$/u.test(implementationHash)) {
  throw new Error("INITIAL_VERIFIER_IMPLEMENTATION_HASH must be a nonzero bytes32");
}
const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const verifierNames = protocolConfig.bootstrapVerifierNames;
if (
  !Array.isArray(verifierNames) ||
  verifierNames.length === 0 ||
  verifierNames.some((name) => !/^[a-z0-9][a-z0-9-]{2,79}$/u.test(name)) ||
  new Set(verifierNames).size !== verifierNames.length
) {
  throw new Error("protocol-config.json contains invalid bootstrapVerifierNames");
}
const verifierIds = verifierNames.map((name) => keccak256(toBytes(name)));

const allocationAddresses = [
  governanceMultisig,
  ecosystemTreasury,
  operationsTreasury,
  validatorTreasury,
  authorTreasury,
  liquidityTreasury,
  founderBeneficiary,
  securityTreasury,
  initialVerifierAdapter,
  ...validators,
];
if (
  new Set(allocationAddresses.map((address) => address.toLowerCase())).size !==
  allocationAddresses.length
) {
  throw new Error("Treasury, founder, verifier, validator, and governance addresses must be distinct");
}
if (
  allocationAddresses.some(
    (address) => address.toLowerCase() === account.address.toLowerCase(),
  )
) {
  throw new Error("The temporary deployer must be distinct from every long-lived role");
}
if (benchmarkGenesis <= 0n || founderVestingStart <= 0n) {
  throw new Error("Genesis and founder vesting timestamps must be positive");
}
if (benchmarkDailyCap <= 0n || benchmarkDailyCap > 204_670_000n) {
  throw new Error("BENCHMARK_DAILY_CAP_APOOL must be between 1 and 204670000");
}

const connectedChainId = await publicClient.getChainId();
if (connectedChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
}
const chainNow = (await publicClient.getBlock()).timestamp;
if (
  founderVestingStart < chainNow - 3_600n ||
  founderVestingStart > chainNow + 86_400n
) {
  throw new Error("FOUNDER_VESTING_START_TIMESTAMP must be within -1h/+24h of chain time");
}
if (
  benchmarkGenesis < chainNow - 3_600n ||
  benchmarkGenesis > chainNow + 30n * 24n * 60n * 60n
) {
  throw new Error("BENCHMARK_GENESIS_TIMESTAMP must be within -1h/+30d of chain time");
}
const deployerBalance = await publicClient.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_DEPLOYER_BALANCE_WEI ?? parseEther("0.02").toString(),
);
if (deployerBalance < minimumBalance) {
  throw new Error(
    `DEPLOYER_BALANCE_TOO_LOW: ${deployerBalance} wei; minimum ${minimumBalance} wei`,
  );
}
console.log(
  `Preflight OK: ${chain.name} (${chainId}), deployer ${account.address}, balance ${deployerBalance} wei`,
);

const founderVesting = await deploy("AgentPoolFounderVesting", [
  founderBeneficiary,
  founderVestingStart,
]);
const benchmarkRewardVault = await deploy("AgentPoolBenchmarkRewardVault", [
  account.address,
  validators,
  benchmarkGenesis,
  initialPolicyVersion,
  benchmarkDailyCap,
]);
const token = await deploy("AgentPoolToken", [
  benchmarkRewardVault,
  ecosystemTreasury,
  operationsTreasury,
  validatorTreasury,
  authorTreasury,
  liquidityTreasury,
  founderVesting,
  securityTreasury,
]);
await write(
  "AgentPoolBenchmarkRewardVault",
  benchmarkRewardVault,
  "configureToken",
  [token],
);

const timelock = await deploy("TimelockController", [
  7n * 24n * 60n * 60n,
  [governanceMultisig],
  [zeroAddress],
  account.address,
]);
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
]);
const jobEscrow = await deploy("AgentPoolJobEscrow", [
  token,
  registry,
  account.address,
  securityTreasury,
]);
const projectResolver = await deploy("AgentPoolProjectResolver", [
  account.address,
  validators,
  initialPolicyVersion,
]);
const projectEscrow = await deploy("AgentPoolProjectEscrow", [
  token,
  registry,
  account.address,
  securityTreasury,
]);

if (chainId === 84532) {
  await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
}
for (const verifierId of verifierIds) {
  await write("AgentPoolRegistry", registry, "configureVerifier", [
    verifierId,
    initialVerifierAdapter,
    implementationHash,
    false,
    true,
  ]);
}
for (const validator of validators) {
  await write("AgentPoolWorkOracle", oracle, "setEvaluator", [validator, true]);
}
await write("AgentPoolWorkOracle", oracle, "setEscrow", [jobEscrow]);
await write("AgentPoolJobEscrow", jobEscrow, "setResolver", [oracle]);
await write(
  "AgentPoolProjectResolver",
  projectResolver,
  "configureProjectEscrow",
  [projectEscrow],
);
await write("AgentPoolProjectEscrow", projectEscrow, "setResolver", [
  projectResolver,
]);

for (const [name, address] of [
  ["AgentPoolBenchmarkRewardVault", benchmarkRewardVault],
  ["AgentPoolRegistry", registry],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", jobEscrow],
  ["AgentPoolProjectResolver", projectResolver],
  ["AgentPoolProjectEscrow", projectEscrow],
  ...(chainId === 84532
    ? [["MockRandomnessProvider", randomnessProvider]]
    : []),
]) {
  await write(name, address, "transferOwnership", [timelock]);
}

await write("TimelockController", timelock, "revokeRole", [
  zeroHash,
  account.address,
]);

const deployment = {
  version: 2,
  chainId,
  network: chain.name,
  deployer: account.address,
  governanceMultisig,
  deployedAt: new Date().toISOString(),
  contracts: {
    token,
    founderVesting,
    benchmarkRewardVault,
    timelock,
    registry,
    license,
    randomnessProvider,
    oracle,
    jobEscrow,
    projectResolver,
    projectEscrow,
  },
  allocations: {
    ecosystemTreasury,
    operationsTreasury,
    validatorTreasury,
    authorTreasury,
    liquidityTreasury,
    founderBeneficiary,
    securityTreasury,
  },
  bootstrap: {
    verifiers: verifierNames.map((name, index) => ({
      name,
      id: verifierIds[index],
    })),
    verifierAdapter: initialVerifierAdapter,
    verifierImplementationHash: implementationHash,
    validators,
    benchmarkGenesis: benchmarkGenesis.toString(),
    benchmarkDailyCap: benchmarkDailyCap.toString(),
    founderVestingStart: founderVestingStart.toString(),
    policyVersion: initialPolicyVersion,
  },
};
const target = path.join(root, "deployments", `${chainId}.json`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Deployment manifest: ${target}`);
