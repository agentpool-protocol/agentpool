import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  zeroHash,
} from "viem";
import { base, baseSepolia } from "viem/chains";

const root = process.cwd();
const chainId = Number(process.env.AGENTPOOL_CHAIN_ID ?? "84532");
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const chain = chainId === 8453 ? base : chainId === 84532 ? baseSepolia : null;
if (!chain) throw new Error("AGENTPOOL_CHAIN_ID must be 84532 or 8453");

const manifestPath =
  process.env.DEPLOYMENT_MANIFEST ??
  path.join(root, "deployments", `${chainId}.json`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== chainId) throw new Error("Deployment manifest chain mismatch");

const client = createPublicClient({ chain, transport: http(rpcUrl) });
const connectedChainId = await client.getChainId();
if (connectedChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
}
const operatorWallet = getAddress(requireEnv("OPERATOR_WALLET"));
const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const verifierIds = protocolConfig.bootstrapVerifierNames.map((name) =>
  keccak256(new TextEncoder().encode(name)),
);
const verifierAdapter = getAddress(requireEnv("INITIAL_VERIFIER_ADAPTER"));
const evaluators = Array.from({ length: 5 }, (_, index) =>
  getAddress(requireEnv(`EVALUATOR_${index + 1}`)),
);
const artifacts = new Map();
function artifact(name) {
  if (!artifacts.has(name)) {
    artifacts.set(
      name,
      JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8")),
    );
  }
  return artifacts.get(name);
}
async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}

const checks = [];
function check(name, actual, expected) {
  const passed =
    typeof expected === "string" && typeof actual === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: typeof actual === "bigint" ? actual.toString() : actual,
    expected: typeof expected === "bigint" ? expected.toString() : expected,
  });
}

const { contracts } = manifest;
const codeHashes = {};
for (const [name, address] of Object.entries(contracts)) {
  const code = await client.getCode({ address });
  check(`bytecode:${name}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") codeHashes[name] = keccak256(code);
}

check(
  "token.totalSupply",
  await read("AgentPoolToken", contracts.token, "totalSupply"),
  parseEther("1000000000"),
);
check(
  "token.operatorAllocation",
  await read("AgentPoolToken", contracts.token, "balanceOf", [
    operatorWallet,
  ]),
  parseEther("200000000"),
);
check(
  "token.miningVaultAllocation",
  await read("AgentPoolToken", contracts.token, "balanceOf", [contracts.miningVault]),
  parseEther("500000000"),
);
check(
  "escrow.permanentProtocolFeeBps",
  await read("AgentPoolJobEscrow", contracts.escrow, "PROTOCOL_FEE_BPS"),
  0,
);
check(
  "escrow.noFeeSetter",
  artifact("AgentPoolJobEscrow").abi.some((entry) => entry.name === "setProtocolFee"),
  false,
);
check(
  "escrow.resolver",
  await read("AgentPoolJobEscrow", contracts.escrow, "resolver"),
  contracts.oracle,
);
check(
  "escrow.registry",
  await read("AgentPoolJobEscrow", contracts.escrow, "registry"),
  contracts.registry,
);
check(
  "oracle.escrow",
  await read("AgentPoolWorkOracle", contracts.oracle, "escrow"),
  contracts.escrow,
);
check(
  "oracle.registry",
  await read("AgentPoolWorkOracle", contracts.oracle, "registry"),
  contracts.registry,
);
for (const [index, verifierId] of verifierIds.entries()) {
  check(
    `registry.verifier${index + 1}Active`,
    await read("AgentPoolRegistry", contracts.registry, "isActiveVerifier", [verifierId]),
    true,
  );
  check(
    `registry.verifier${index + 1}Authorized`,
    await read("AgentPoolRegistry", contracts.registry, "isAuthorizedVerifier", [
      verifierId,
      verifierAdapter,
    ]),
    true,
  );
  check(
    `registry.verifier${index + 1}MiningEligible`,
    await read("AgentPoolRegistry", contracts.registry, "isMiningVerifier", [verifierId]),
    true,
  );
}
for (const [index, evaluator] of evaluators.entries()) {
  check(
    `oracle.evaluator${index + 1}Eligible`,
    await read("AgentPoolWorkOracle", contracts.oracle, "isEligible", [evaluator]),
    true,
  );
}
check(
  "mining.configuredBudget",
  await read("AgentPoolMiningVault", contracts.miningVault, "configuredBudget"),
  parseEther("500000000"),
);
check(
  "timelock.minDelay",
  await read("TimelockController", contracts.timelock, "getMinDelay"),
  7n * 24n * 60n * 60n,
);
check(
  "governor.quorumNumerator",
  await read("AgentPoolGovernor", contracts.governor, "quorumNumerator"),
  25n,
);
check(
  "governor.proposalThreshold",
  await read("AgentPoolGovernor", contracts.governor, "proposalThreshold"),
  parseEther("10000000"),
);
check(
  "governor.votingPeriod",
  await read("AgentPoolGovernor", contracts.governor, "votingPeriod"),
  302400n,
);

for (const [name, address] of [
  ["AgentPoolRegistry", contracts.registry],
  ["AgentPoolWorkOracle", contracts.oracle],
  ["AgentPoolJobEscrow", contracts.escrow],
  ["AgentPoolMiningVault", contracts.miningVault],
  ...(chainId === 84532
    ? [["MockRandomnessProvider", contracts.randomnessProvider]]
    : []),
]) {
  check(
    `owner:${name}`,
    await read(name, address, "owner"),
    contracts.timelock,
  );
}

const proposerRole = keccak256(toBytes("PROPOSER_ROLE"));
const cancellerRole = keccak256(toBytes("CANCELLER_ROLE"));
check(
  "timelock.governorProposer",
  await read("TimelockController", contracts.timelock, "hasRole", [
    proposerRole,
    contracts.governor,
  ]),
  true,
);
check(
  "timelock.governorCanceller",
  await read("TimelockController", contracts.timelock, "hasRole", [
    cancellerRole,
    contracts.governor,
  ]),
  true,
);
for (const [label, role] of [
  ["admin", zeroHash],
  ["proposer", proposerRole],
  ["canceller", cancellerRole],
]) {
  check(
    `deployerRoleRemoved:${label}`,
    await read("TimelockController", contracts.timelock, "hasRole", [
      role,
      manifest.deployer,
    ]),
    false,
  );
}
if (chainId === 84532) {
  check(
    "mockRandomness.consumer",
    await read(
      "MockRandomnessProvider",
      contracts.randomnessProvider,
      "consumer",
    ),
    contracts.oracle,
  );
}

const failures = checks.filter((entry) => !entry.passed);
const evidence = {
  version: 1,
  verifiedAt: new Date().toISOString(),
  chainId,
  network: chain.name,
  deploymentManifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
  manifest,
  codeHashes,
  checks,
  status: failures.length === 0 ? "passed" : "failed",
};
const outputPath = path.join(root, "deployments", `${chainId}.verification.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} deployment verification checks failed`);
}
console.log(`Deployment verification passed (${checks.length} checks): ${outputPath}`);
