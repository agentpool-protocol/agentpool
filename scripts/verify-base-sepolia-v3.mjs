import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256 } from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath =
  process.env.V3_DEPLOYMENT_MANIFEST ??
  path.join(root, "deployments", "84532.v3.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 84532 || manifest.version !== 3) {
  throw new Error("Expected an AgentPool Base Sepolia v3 manifest");
}
const rpcUrl = process.env.AGENTPOOL_RPC_URL;
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL is required");
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if ((await client.getChainId()) !== 84532) throw new Error("RPC chain mismatch");

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

const names = {
  registry: "AgentPoolRegistry",
  randomnessProvider: "MockRandomnessProvider",
  oracle: "AgentPoolWorkOracle",
  jobEscrow: "AgentPoolJobEscrow",
  projectResolver: "AgentPoolProjectResolver",
  projectEscrow: "AgentPoolProjectEscrow",
};
const codeHashes = {};
for (const [key, name] of Object.entries(names)) {
  const code = await client.getCode({ address: manifest.contracts[key] });
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") codeHashes[key] = keccak256(code);
  artifact(name);
}
for (const [key, address] of Object.entries(manifest.sharedContracts)) {
  const code = await client.getCode({ address });
  check(`sharedBytecode:${key}`, Boolean(code && code !== "0x"), true);
}

const { contracts, sharedContracts, bootstrap, allocations } = manifest;
for (const [key, name] of Object.entries(names)) {
  check(
    `owner:${key}`,
    await read(name, contracts[key], "owner"),
    sharedContracts.timelock,
  );
}
check(
  "job.token",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "apool"),
  sharedContracts.token,
);
check(
  "project.token",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "apool"),
  sharedContracts.token,
);
check(
  "job.registry",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "registry"),
  contracts.registry,
);
check(
  "project.registry",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "registry"),
  contracts.registry,
);
check(
  "job.security",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "securityTreasury"),
  allocations.securityTreasury,
);
check(
  "project.security",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "securityTreasury"),
  allocations.securityTreasury,
);
check(
  "job.resolver",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "resolver"),
  contracts.oracle,
);
check(
  "oracle.escrow",
  await read("AgentPoolWorkOracle", contracts.oracle, "escrow"),
  contracts.jobEscrow,
);
check(
  "project.resolver",
  await read("AgentPoolProjectEscrow", contracts.projectEscrow, "resolver"),
  contracts.projectResolver,
);
check(
  "projectResolver.escrow",
  await read(
    "AgentPoolProjectResolver",
    contracts.projectResolver,
    "projectEscrow",
  ),
  contracts.projectEscrow,
);
check(
  "randomness.consumer",
  await read("MockRandomnessProvider", contracts.randomnessProvider, "consumer"),
  contracts.oracle,
);

for (const [name, address] of [
  ["AgentPoolJobEscrow", contracts.jobEscrow],
  ["AgentPoolProjectEscrow", contracts.projectEscrow],
]) {
  check(`${name}.validatorShare`, await read(name, address, "VALIDATOR_SHARE_BPS"), 9000);
  check(`${name}.burnShare`, await read(name, address, "BURN_SHARE_BPS"), 0);
  check(`${name}.securityShare`, await read(name, address, "SECURITY_SHARE_BPS"), 1000);
}
check(
  "job.protocolFee",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "PROTOCOL_FEE_BPS"),
  0,
);
check(
  "job.minimumPrice",
  await read(
    "AgentPoolJobEscrow",
    contracts.jobEscrow,
    "MIN_VERIFIED_JOB_PRICE",
  ),
  1000n,
);
check(
  "project.minimumTaskPrice",
  await read(
    "AgentPoolProjectEscrow",
    contracts.projectEscrow,
    "MIN_VERIFIED_TASK_PRICE",
  ),
  1000n,
);
check(
  "job.disputeFee",
  await read("AgentPoolJobEscrow", contracts.jobEscrow, "DISPUTE_FEE"),
  50n,
);

for (const [index, verifier] of bootstrap.verifiers.entries()) {
  check(
    `verifier:${index}:active`,
    await read("AgentPoolRegistry", contracts.registry, "isActiveVerifier", [
      verifier.id,
    ]),
    true,
  );
  check(
    `verifier:${index}:fee`,
    await read(
      "AgentPoolRegistry",
      contracts.registry,
      "validationFeeForVerifier",
      [verifier.id],
    ),
    BigInt(verifier.validationFeeApool),
  );
  check(
    `verifier:${index}:authorized`,
    await read(
      "AgentPoolRegistry",
      contracts.registry,
      "isAuthorizedVerifier",
      [verifier.id, bootstrap.verifierAdapter],
    ),
    true,
  );
}
for (const [index, validator] of bootstrap.validators.entries()) {
  check(
    `oracle.validator:${index}`,
    await read("AgentPoolWorkOracle", contracts.oracle, "isEligible", [validator]),
    true,
  );
  check(
    `project.validator:${index}`,
    await read(
      "AgentPoolProjectResolver",
      contracts.projectResolver,
      "isValidator",
      [validator],
    ),
    true,
  );
}

const failed = checks.filter((item) => !item.passed);
const evidence = {
  version: 3,
  chainId: 84532,
  manifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
  verifiedAt: new Date().toISOString(),
  latestBlock: (await client.getBlockNumber()).toString(),
  codeHashes,
  checks,
  status: failed.length === 0 ? "passed" : "failed",
};
const evidencePath = path.join(root, "deployments", "84532.v3.verification.json");
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failed.length > 0) {
  throw new Error(`AgentPool v3 verification failed: ${failed.map(({ name }) => name).join(", ")}`);
}
console.log(
  `AgentPool v3 verified on Base Sepolia: ${checks.length} checks at block ${evidence.latestBlock}`,
);
console.log(`Verification evidence: ${evidencePath}`);
