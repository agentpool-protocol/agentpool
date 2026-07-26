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

const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const roleNames = [
  "GOVERNANCE_MULTISIG",
  "ECOSYSTEM_TREASURY",
  "OPERATIONS_TREASURY",
  "VALIDATOR_TREASURY",
  "AUTHOR_TREASURY",
  "LIQUIDITY_TREASURY",
  "FOUNDER_BENEFICIARY",
  "SECURITY_TREASURY",
  "INITIAL_VERIFIER_ADAPTER",
  "VALIDATOR_1",
  "VALIDATOR_2",
  "VALIDATOR_3",
  "VALIDATOR_4",
  "VALIDATOR_5",
];
const roles = roleNames.map((name) => getAddress(requireEnv(name)));
if (new Set(roles.map((address) => address.toLowerCase())).size !== roles.length) {
  throw new Error("All governance, allocation, verifier, and validator addresses must be distinct");
}
if (roles.some((address) => address.toLowerCase() === account.address.toLowerCase())) {
  throw new Error("Deployer must be distinct from every long-lived role");
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
const implementationHash = requireEnv("INITIAL_VERIFIER_IMPLEMENTATION_HASH");
if (!/^0x[0-9a-fA-F]{64}$/u.test(implementationHash) || /^0x0{64}$/u.test(implementationHash)) {
  throw new Error("INITIAL_VERIFIER_IMPLEMENTATION_HASH must be a nonzero bytes32");
}
const benchmarkGenesis = BigInt(requireEnv("BENCHMARK_GENESIS_TIMESTAMP"));
const founderVestingStart = BigInt(requireEnv("FOUNDER_VESTING_START_TIMESTAMP"));
const benchmarkDailyCap = BigInt(
  process.env.BENCHMARK_DAILY_CAP_APOOL ?? "1000000",
);
if (benchmarkGenesis <= 0n || founderVestingStart <= 0n) {
  throw new Error("Genesis and vesting timestamps must be positive");
}
if (benchmarkDailyCap <= 0n || benchmarkDailyCap > 204_670_000n) {
  throw new Error("BENCHMARK_DAILY_CAP_APOOL must be between 1 and 204670000");
}
const siteUrl = new URL(requireEnv("PUBLIC_SITE_URL"));
if (siteUrl.protocol !== "https:") {
  throw new Error("PUBLIC_SITE_URL must use HTTPS");
}

const requiredArtifacts = [
  "AgentPoolFounderVesting",
  "AgentPoolBenchmarkRewardVault",
  "AgentPoolToken",
  "TimelockController",
  "AgentPoolRegistry",
  "AgentPoolLicense",
  "AgentPoolWorkOracle",
  "AgentPoolJobEscrow",
  "AgentPoolProjectResolver",
  "AgentPoolProjectEscrow",
  ...(chainId === 8453 ? [] : ["MockRandomnessProvider"]),
];
const artifactHashes = {};
const runtimeBytes = {};
for (const name of requiredArtifacts) {
  const compiled = JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
  if (!compiled.bytecode || compiled.bytecode === "0x") {
    throw new Error(`Missing bytecode for ${name}`);
  }
  const size = (compiled.deployedBytecode.length - 2) / 2;
  if (size > 24_576) {
    throw new Error(`${name} exceeds the EIP-170 runtime size limit`);
  }
  artifactHashes[name] = keccak256(compiled.bytecode);
  runtimeBytes[name] = size;
}

const client = createPublicClient({ chain, transport: http(rpcUrl) });
const connectedChainId = await client.getChainId();
if (connectedChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
}
const chainNow = (await client.getBlock()).timestamp;
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
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_DEPLOYER_BALANCE_WEI ?? parseEther("0.02").toString(),
);
if (balance < minimumBalance) {
  throw new Error(`DEPLOYER_BALANCE_TOO_LOW: ${balance} < ${minimumBalance}`);
}
if (chainId === 8453) {
  const vrf = getAddress(requireEnv("CHAINLINK_VRF_ADAPTER"));
  const code = await client.getCode({ address: vrf });
  if (!code || code === "0x") {
    throw new Error("MAINNET_BLOCKED: VRF adapter has no code");
  }
}

console.log(JSON.stringify({
  status: "ready",
  version: 2,
  chainId,
  network: chain.name,
  deployer: account.address,
  balanceWei: balance.toString(),
  minimumBalanceWei: minimumBalance.toString(),
  benchmarkGenesis: benchmarkGenesis.toString(),
  founderVestingStart: founderVestingStart.toString(),
  benchmarkDailyCapApool: benchmarkDailyCap.toString(),
  publicSiteUrl: siteUrl.origin,
  artifactHashes,
  runtimeBytes,
  verifiers: verifierNames,
  validatorCount: 5,
}, null, 2));
