import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
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
if (manifest.chainId !== chainId || manifest.version !== 2) {
  throw new Error("Deployment manifest is not an AgentPool v2 manifest for this chain");
}

const client = createPublicClient({ chain, transport: http(rpcUrl) });
if (await client.getChainId() !== chainId) {
  throw new Error("RPC chain mismatch");
}
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

const { contracts, allocations, bootstrap } = manifest;
const contractArtifacts = {
  token: "AgentPoolToken",
  founderVesting: "AgentPoolFounderVesting",
  benchmarkRewardVault: "AgentPoolBenchmarkRewardVault",
  timelock: "TimelockController",
  registry: "AgentPoolRegistry",
  license: "AgentPoolLicense",
  randomnessProvider: chainId === 84532 ? "MockRandomnessProvider" : null,
  oracle: "AgentPoolWorkOracle",
  jobEscrow: "AgentPoolJobEscrow",
  projectResolver: "AgentPoolProjectResolver",
  projectEscrow: "AgentPoolProjectEscrow",
};
const codeHashes = {};
for (const [key, address] of Object.entries(contracts)) {
  const code = await client.getCode({ address });
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") codeHashes[key] = keccak256(code);
  if (contractArtifacts[key]) artifact(contractArtifacts[key]);
}

check("token.totalSupply", await read("AgentPoolToken", contracts.token, "totalSupply"), 1_000_000_000_000n);
check("token.decimals", await read("AgentPoolToken", contracts.token, "decimals"), 0);
for (const [label, address, amount] of [
  ["benchmark", contracts.benchmarkRewardVault, 400_000_000_000n],
  ["ecosystem", allocations.ecosystemTreasury, 200_000_000_000n],
  ["operations", allocations.operationsTreasury, 100_000_000_000n],
  ["validators", allocations.validatorTreasury, 60_000_000_000n],
  ["authors", allocations.authorTreasury, 40_000_000_000n],
  ["liquidity", allocations.liquidityTreasury, 100_000_000_000n],
  ["founder", contracts.founderVesting, 50_000_000_000n],
  ["security", allocations.securityTreasury, 50_000_000_000n],
]) {
  check(
    `token.allocation:${label}`,
    await read("AgentPoolToken", contracts.token, "balanceOf", [address]),
    amount,
  );
}
check(
  "benchmark.token",
  await read("AgentPoolBenchmarkRewardVault", contracts.benchmarkRewardVault, "apool"),
  contracts.token,
);
check(
  "benchmark.policyVersion",
  await read("AgentPoolBenchmarkRewardVault", contracts.benchmarkRewardVault, "policyVersion"),
  Number(bootstrap.policyVersion),
);
check(
  "benchmark.dailyCap",
  await read("AgentPoolBenchmarkRewardVault", contracts.benchmarkRewardVault, "dailyCap"),
  BigInt(bootstrap.benchmarkDailyCap),
);
for (const [index, validator] of bootstrap.validators.entries()) {
  check(
    `benchmark.validator${index + 1}`,
    await read(
      "AgentPoolBenchmarkRewardVault",
      contracts.benchmarkRewardVault,
      "isValidator",
      [validator],
    ),
    true,
  );
  check(
    `projectResolver.validator${index + 1}`,
    await read(
      "AgentPoolProjectResolver",
      contracts.projectResolver,
      "isValidator",
      [validator],
    ),
    true,
  );
  check(
    `oracle.evaluator${index + 1}`,
    await read("AgentPoolWorkOracle", contracts.oracle, "isEligible", [validator]),
    true,
  );
}

check(
  "jobEscrow.workerPriceFee",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "PROTOCOL_FEE_BPS"),
  0,
);
for (const [contractName, address] of [
  ["AgentPoolJobEscrow", contracts.jobEscrow],
  ["AgentPoolProjectEscrow", contracts.projectEscrow],
]) {
  check(
    `${contractName}.validationFee`,
    await read(contractName, address, "VALIDATION_FEE_BPS"),
    300,
  );
  check(
    `${contractName}.validatorShare`,
    await read(contractName, address, "VALIDATOR_SHARE_BPS"),
    7000,
  );
  check(
    `${contractName}.burnShare`,
    await read(contractName, address, "BURN_SHARE_BPS"),
    2000,
  );
  check(
    `${contractName}.securityShare`,
    await read(contractName, address, "SECURITY_SHARE_BPS"),
    1000,
  );
  check(
    `${contractName}.minimumValidationFee`,
    await read(contractName, address, "MIN_VALIDATION_FEE"),
    10,
  );
}
check(
  "jobEscrow.verifierProposalTimeout",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "RESOLUTION_GRACE"),
  3n * 24n * 60n * 60n,
);
check(
  "jobEscrow.minimumSellerBond",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "MIN_SELLER_BOND"),
  10,
);
check(
  "projectEscrow.minimumWorkerBond",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "MIN_WORKER_BOND"),
  10,
);
check(
  "oracle.validatorSelectionTimeout",
  await read("AgentPoolWorkOracle", contracts.oracle, "SELECTION_TIMEOUT"),
  24n * 60n * 60n,
);
check("jobEscrow.resolver", await read("AgentPoolJobEscrow", contracts.jobEscrow, "resolver"), contracts.oracle);
check(
  "projectEscrow.resolver",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "resolver"),
  contracts.projectResolver,
);
check(
  "projectResolver.escrow",
  await read("AgentPoolProjectResolver", contracts.projectResolver, "projectEscrow"),
  contracts.projectEscrow,
);
check("oracle.escrow", await read("AgentPoolWorkOracle", contracts.oracle, "escrow"), contracts.jobEscrow);

for (const [index, verifier] of bootstrap.verifiers.entries()) {
  check(
    `registry.verifier${index + 1}Active`,
    await read("AgentPoolRegistry", contracts.registry, "isActiveVerifier", [verifier.id]),
    true,
  );
  check(
    `registry.verifier${index + 1}Authorized`,
    await read("AgentPoolRegistry", contracts.registry, "isAuthorizedVerifier", [
      verifier.id,
      bootstrap.verifierAdapter,
    ]),
    true,
  );
  check(
    `registry.verifier${index + 1}NotMining`,
    await read("AgentPoolRegistry", contracts.registry, "isMiningVerifier", [verifier.id]),
    false,
  );
}

check(
  "founder.owner",
  await read("AgentPoolFounderVesting", contracts.founderVesting, "owner"),
  allocations.founderBeneficiary,
);
check(
  "founder.duration",
  await read("AgentPoolFounderVesting", contracts.founderVesting, "duration"),
  4n * 365n * 24n * 60n * 60n,
);
check(
  "founder.start",
  await read("AgentPoolFounderVesting", contracts.founderVesting, "start"),
  BigInt(bootstrap.founderVestingStart),
);
check(
  "founder.cliff",
  await read("AgentPoolFounderVesting", contracts.founderVesting, "cliff"),
  await read("AgentPoolFounderVesting", contracts.founderVesting, "start") +
    365n * 24n * 60n * 60n,
);

for (const [name, address] of [
  ["AgentPoolBenchmarkRewardVault", contracts.benchmarkRewardVault],
  ["AgentPoolRegistry", contracts.registry],
  ["AgentPoolWorkOracle", contracts.oracle],
  ["AgentPoolJobEscrow", contracts.jobEscrow],
  ["AgentPoolProjectResolver", contracts.projectResolver],
  ["AgentPoolProjectEscrow", contracts.projectEscrow],
  ...(chainId === 84532
    ? [["MockRandomnessProvider", contracts.randomnessProvider]]
    : []),
]) {
  check(`owner:${name}`, await read(name, address, "owner"), contracts.timelock);
}
check(
  "timelock.minDelay",
  await read("TimelockController", contracts.timelock, "getMinDelay"),
  7n * 24n * 60n * 60n,
);
const proposerRole = keccak256(toBytes("PROPOSER_ROLE"));
const cancellerRole = keccak256(toBytes("CANCELLER_ROLE"));
check(
  "timelock.multisigProposer",
  await read("TimelockController", contracts.timelock, "hasRole", [
    proposerRole,
    manifest.governanceMultisig,
  ]),
  true,
);
check(
  "timelock.multisigCanceller",
  await read("TimelockController", contracts.timelock, "hasRole", [
    cancellerRole,
    manifest.governanceMultisig,
  ]),
  true,
);
check(
  "timelock.deployerAdminRemoved",
  await read("TimelockController", contracts.timelock, "hasRole", [
    zeroHash,
    manifest.deployer,
  ]),
  false,
);
if (chainId === 84532) {
  check(
    "mockRandomness.consumer",
    await read("MockRandomnessProvider", contracts.randomnessProvider, "consumer"),
    contracts.oracle,
  );
}

const failures = checks.filter((entry) => !entry.passed);
const evidence = {
  version: 2,
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
