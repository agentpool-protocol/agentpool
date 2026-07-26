import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  nonceManager,
  parseEther,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const chainId = Number(process.env.AGENTPOOL_CHAIN_ID ?? "84532");
if (chainId !== 84532) throw new Error("This smoke test is Base Sepolia only");
if (process.env.AGENTPOOL_WALLET_PROFILE !== "base-sepolia-disposable") {
  throw new Error("This smoke test requires the disposable Base Sepolia wallet profile");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}

const manifestPath = path.join(root, "deployments", "84532.v3.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error("Base Sepolia deployment manifest is missing");
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const transport = http(requireEnv("AGENTPOOL_RPC_URL"));
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const managedAccount = (privateKey) =>
  privateKeyToAccount(privateKey, { nonceManager });
const deployer = managedAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const buyer = managedAccount(requireEnv("TESTNET_ECOSYSTEM_PRIVATE_KEY"));
const coordinator = managedAccount(requireEnv("TESTNET_AUTHOR_PRIVATE_KEY"));
const worker = managedAccount(requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY"));
const validatorAccounts = Array.from({ length: 3 }, (_, index) =>
  managedAccount(requireEnv(`TESTNET_VALIDATOR_${index + 1}_PRIVATE_KEY`)),
);
const walletFor = (account) =>
  createWalletClient({ account, chain: baseSepolia, transport });
const deployerWallet = walletFor(deployer);
const progressPath = path.join(
  root,
  "deployments",
  "84532.v3.commerce-smoke.progress.json",
);

const expectedIdentities = [
  [deployer.address, manifest.deployer, "deployer"],
  [buyer.address, manifest.allocations.ecosystemTreasury, "buyer"],
  [coordinator.address, manifest.allocations.authorTreasury, "coordinator"],
  [worker.address, manifest.allocations.operationsTreasury, "worker"],
  ...validatorAccounts.map((account, index) => [
    account.address,
    manifest.bootstrap.validators[index],
    `validator${index + 1}`,
  ]),
];
for (const [actual, expected, label] of expectedIdentities) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} private key does not match the deployment manifest`);
  }
}

const transactions = [];
async function waitFor(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
  });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  transactions.push({ label, hash, blockNumber: receipt.blockNumber.toString() });
  fs.writeFileSync(
    progressPath,
    `${JSON.stringify(
      {
        chainId,
        status: "in_progress",
        transactions,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return receipt;
}
async function write(account, contractName, address, functionName, args = []) {
  const hash = await walletFor(account).writeContract({
    account,
    address,
    abi: artifact(contractName).abi,
    functionName,
    args,
    gas: 1_500_000n,
  });
  await waitFor(hash, `${contractName}.${functionName}`);
  return hash;
}
async function read(contractName, address, functionName, args = []) {
  return publicClient.readContract({
    address,
    abi: artifact(contractName).abi,
    functionName,
    args,
  });
}
async function ensureTestGas(account, target) {
  const current = await publicClient.getBalance({ address: account.address });
  if (current >= target) return;
  const hash = await deployerWallet.sendTransaction({
    account: deployer,
    to: account.address,
    value: target - current,
    gas: 21_000n,
  });
  await waitFor(hash, `fund-gas:${account.address}`);
}

const targetRoleGas = parseEther("0.00005");
for (const account of [buyer, coordinator, worker]) {
  await ensureTestGas(account, targetRoleGas);
}

const token = manifest.sharedContracts.token;
const projectEscrow = manifest.contracts.projectEscrow;
const projectResolver = manifest.contracts.projectResolver;
const securityTreasury = manifest.allocations.securityTreasury;
const verifierId = manifest.bootstrap.verifiers[1].id;
const price = 1_000n;
const validationFee = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "validationFeeFor",
  [verifierId],
);
const validationReserve = 30n;
const workerBond = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "workerBondFor",
  [price],
);
const projectId = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "nextProjectId",
);
const taskId = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "nextTaskId",
);
const latestBlock = await publicClient.getBlock();
const projectDeadline = latestBlock.timestamp + 7_200n;
const taskDeadline = latestBlock.timestamp + 6_600n;
const request = {
  id: "base-sepolia-codex-order-001",
  prompt: "Calculate each line total and the grand total.",
  rows: [
    { sku: "alpha", quantity: 2, unitPrice: 125 },
    { sku: "beta", quantity: 3, unitPrice: 80 },
  ],
};
const delivery = {
  lineTotals: [
    { sku: "alpha", total: 250 },
    { sku: "beta", total: 240 },
  ],
  grandTotal: 490,
};
const reproducedDelivery = {
  lineTotals: request.rows.map((row) => ({
    sku: row.sku,
    total: row.quantity * row.unitPrice,
  })),
  grandTotal: request.rows.reduce(
    (total, row) => total + row.quantity * row.unitPrice,
    0,
  ),
};
if (JSON.stringify(delivery) !== JSON.stringify(reproducedDelivery)) {
  throw new Error("Codex delivery failed deterministic validation");
}
const briefHash = keccak256(toBytes(JSON.stringify(request)));
const deliveryHash = keccak256(toBytes(JSON.stringify(delivery)));
const dependencies = [];
const dependenciesHash = keccak256(
  encodeAbiParameters([{ type: "uint256[]" }], [dependencies]),
);
const taskLeaf = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "taskLeaf",
  [
    projectId,
    worker.address,
    price,
    taskDeadline,
    briefHash,
    dependenciesHash,
    verifierId,
  ],
);

const workerBefore = await read("AgentPoolToken", token, "balanceOf", [
  worker.address,
]);
const buyerBefore = await read("AgentPoolToken", token, "balanceOf", [
  buyer.address,
]);
const securityBefore = await read("AgentPoolToken", token, "balanceOf", [
  securityTreasury,
]);
const supplyBefore = await read("AgentPoolToken", token, "totalSupply");
const validatorBalancesBefore = await Promise.all(
  validatorAccounts.map((account) =>
    read("AgentPoolToken", token, "balanceOf", [account.address]),
  ),
);

await write(
  buyer,
  "AgentPoolToken",
  token,
  "approve",
  [projectEscrow, price + validationReserve],
);
await write(
  buyer,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "createProject",
  [coordinator.address, price, 1, 1, projectDeadline, briefHash],
);
await write(
  coordinator,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "postPlan",
  [projectId, taskLeaf, 1],
);
await write(
  buyer,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "approvePlan",
  [projectId],
);
await write(
  coordinator,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "addTask",
  [
    projectId,
    worker.address,
    price,
    taskDeadline,
    briefHash,
    dependencies,
    verifierId,
    [],
  ],
);
await write(
  worker,
  "AgentPoolToken",
  token,
  "approve",
  [projectEscrow, workerBond],
);
await write(
  worker,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "acceptTask",
  [taskId],
);
await write(
  worker,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "submitTask",
  [taskId, deliveryHash],
);

const resolution = {
  taskId,
  outcome: 0,
  evidenceHash: deliveryHash,
  policyVersion: Number(manifest.bootstrap.policyVersion),
  expiresAt: latestBlock.timestamp + 3_600n,
};
const resolutionTypes = {
  TaskResolution: [
    { name: "taskId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
};
const signatures = await Promise.all(
  validatorAccounts.map((account) =>
    account.signTypedData({
      domain: {
        name: "AgentPool Project Resolver",
        version: "2",
        chainId,
        verifyingContract: projectResolver,
      },
      types: resolutionTypes,
      primaryType: "TaskResolution",
      message: resolution,
    }),
  ),
);
await write(
  deployer,
  "AgentPoolProjectResolver",
  projectResolver,
  "resolve",
  [resolution, signatures],
);
await write(
  deployer,
  "AgentPoolProjectEscrow",
  projectEscrow,
  "finalizeProject",
  [projectId],
);

const workerAfter = await read("AgentPoolToken", token, "balanceOf", [
  worker.address,
]);
const buyerAfter = await read("AgentPoolToken", token, "balanceOf", [
  buyer.address,
]);
const securityAfter = await read("AgentPoolToken", token, "balanceOf", [
  securityTreasury,
]);
const supplyAfter = await read("AgentPoolToken", token, "totalSupply");
const validatorBalancesAfter = await Promise.all(
  validatorAccounts.map((account) =>
    read("AgentPoolToken", token, "balanceOf", [account.address]),
  ),
);
const escrowAfter = await read("AgentPoolToken", token, "balanceOf", [
  projectEscrow,
]);
const project = await read(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "projects",
  [projectId],
);
const expectedValidatorShare = (validationFee * 9_000n) / 10_000n;
const expectedBurn = 0n;
const expectedSecurity = validationFee - expectedValidatorShare;
const expectedPerValidator = expectedValidatorShare / 3n;
const checks = [
  ["delivery.validated", true, true],
  ["worker.fullPrice", workerAfter - workerBefore, price],
  ["buyer.priceAndValidationFee", buyerBefore - buyerAfter, price + validationFee],
  ["token.burn", supplyBefore - supplyAfter, expectedBurn],
  ["security.reward", securityAfter - securityBefore, expectedSecurity],
  ["escrow.empty", escrowAfter, 0n],
  ["project.completed", project[12], 4],
  ...validatorBalancesAfter.map((balance, index) => [
    `validator${index + 1}.reward`,
    balance - validatorBalancesBefore[index],
    expectedPerValidator,
  ]),
].map(([name, actual, expected]) => ({
  name,
  actual: typeof actual === "bigint" ? actual.toString() : actual,
  expected: typeof expected === "bigint" ? expected.toString() : expected,
  passed: actual === expected,
}));
const failures = checks.filter((entry) => !entry.passed);
const evidence = {
  version: 3,
  chainId,
  network: "Base Sepolia",
  projectId: projectId.toString(),
  taskId: taskId.toString(),
  request,
  delivery,
  deliveryHash,
  deterministicValidationPassed: true,
  worker: worker.address,
  buyer: buyer.address,
  coordinator: coordinator.address,
  price: price.toString(),
  validationFee: validationFee.toString(),
  workerBond: workerBond.toString(),
  validatorSignatures: signatures.length,
  checks,
  transactions,
  status: failures.length === 0 ? "passed" : "failed",
  completedAt: new Date().toISOString(),
};
const outputPath = path.join(root, "deployments", "84532.v3.commerce-smoke.json");
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`Commerce smoke test failed ${failures.length} checks`);
}
fs.rmSync(progressPath, { force: true });
console.log(
  `Base Sepolia commerce smoke passed: project ${projectId}, task ${taskId}, ${transactions.length} transactions, ${checks.length} checks.`,
);
console.log(`Smoke evidence: ${outputPath}`);
