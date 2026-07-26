import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  nonceManager,
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
function jsonHash(value) {
  return keccak256(toBytes(JSON.stringify(value)));
}

const manifestPath = path.join(root, "deployments", "84532.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error("Base Sepolia deployment manifest is missing");
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const transport = http(requireEnv("AGENTPOOL_RPC_URL"));
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const waitForGenesis = process.argv.includes("--wait");
const deployer = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"), {
  nonceManager,
});
const worker = privateKeyToAccount(
  requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY"),
);
const validators = Array.from({ length: 3 }, (_, index) =>
  privateKeyToAccount(requireEnv(`TESTNET_VALIDATOR_${index + 1}_PRIVATE_KEY`)),
);
if (deployer.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("Deployer private key does not match the deployment manifest");
}
if (
  worker.address.toLowerCase() !==
  manifest.allocations.operationsTreasury.toLowerCase()
) {
  throw new Error("Worker private key does not match the deployment manifest");
}
for (const [index, validator] of validators.entries()) {
  if (
    validator.address.toLowerCase() !==
    manifest.bootstrap.validators[index].toLowerCase()
  ) {
    throw new Error(
      `Validator ${index + 1} private key does not match the deployment manifest`,
    );
  }
}

const vault = manifest.contracts.benchmarkRewardVault;
const token = manifest.contracts.token;
const vaultAbi = artifact("AgentPoolBenchmarkRewardVault").abi;
const tokenAbi = artifact("AgentPoolToken").abi;
let latestBlock = await publicClient.getBlock();
const genesis = await publicClient.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: "genesis",
});
const outputPath = path.join(root, "deployments", "84532.mining-smoke.json");
if (latestBlock.timestamp < genesis) {
  const pending = {
    version: 2,
    chainId,
    network: "Base Sepolia",
    status: "pending_genesis",
    currentBlockTimestamp: latestBlock.timestamp.toString(),
    genesis: genesis.toString(),
    startsAt: new Date(Number(genesis) * 1_000).toISOString(),
    remainingSeconds: (genesis - latestBlock.timestamp).toString(),
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(pending, null, 2)}\n`);
  if (!waitForGenesis) {
    console.log(
      `Mining has not started. Genesis: ${pending.startsAt}; remaining block seconds: ${pending.remainingSeconds}.`,
    );
    process.exit(0);
  }
  console.log(
    `Waiting for Base Sepolia mining genesis ${pending.startsAt}; remaining block seconds: ${pending.remainingSeconds}.`,
  );
  while (latestBlock.timestamp < genesis) {
    const remaining = genesis - latestBlock.timestamp;
    const delaySeconds = Number(remaining > 30n ? 30n : remaining + 1n);
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
    latestBlock = await publicClient.getBlock();
  }
  console.log(`Mining genesis reached at block ${latestBlock.number}.`);
}

const challenge = {
  id: "base-sepolia-codex-mining-001",
  task: "Sort the integers, remove duplicates, and calculate the weighted checksum.",
  values: [17, 4, 23, 9, 17, 12],
  checksumRule: "sum(value * oneBasedIndex)",
};
const sortedUnique = [...new Set(challenge.values)].sort(
  (left, right) => left - right,
);
const solution = {
  sortedUnique,
  weightedChecksum: sortedUnique.reduce(
    (total, value, index) => total + value * (index + 1),
    0,
  ),
};
const expected = {
  sortedUnique: [4, 9, 12, 17, 23],
  weightedChecksum: 241,
};
const deterministicValidationPassed =
  JSON.stringify(solution) === JSON.stringify(expected);
if (!deterministicValidationPassed) {
  throw new Error("Codex mining solution failed deterministic validation");
}

const challengeId = jsonHash(challenge);
const alreadyClaimed = await publicClient.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: "claimedChallenge",
  args: [challengeId],
});
if (alreadyClaimed) {
  throw new Error(
    "This mining challenge is already claimed; inspect existing evidence instead of replaying it",
  );
}
const policyVersion = await publicClient.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: "policyVersion",
});
const day = (latestBlock.timestamp - genesis) / 86_400n;
const receipt = {
  challengeId,
  submissionHash: jsonHash(solution),
  minerId: keccak256(toBytes("codex-agent-base-sepolia-v1")),
  recipient: worker.address,
  trackId: keccak256(toBytes("code")),
  leagueId: keccak256(toBytes("container")),
  policyVersion: Number(policyVersion),
  accuracyBps: 10_000,
  efficiencyBps: 2_000,
  baseReward: 100n,
  reward: 120n,
  day,
  expiresAt: latestBlock.timestamp + 3_600n,
};
const receiptTypes = {
  RewardReceipt: [
    { name: "challengeId", type: "bytes32" },
    { name: "submissionHash", type: "bytes32" },
    { name: "minerId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "trackId", type: "bytes32" },
    { name: "leagueId", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
    { name: "accuracyBps", type: "uint16" },
    { name: "efficiencyBps", type: "uint16" },
    { name: "baseReward", type: "uint128" },
    { name: "reward", type: "uint128" },
    { name: "day", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};
const signatures = await Promise.all(
  validators.map((validator) =>
    validator.signTypedData({
      domain: {
        name: "AgentPool Benchmark Mining",
        version: "2",
        chainId,
        verifyingContract: vault,
      },
      types: receiptTypes,
      primaryType: "RewardReceipt",
      message: receipt,
    }),
  ),
);
const readToken = (functionName, args = []) =>
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName,
    args,
  });
const [workerBefore, vaultBefore, supplyBefore, spentBefore] =
  await Promise.all([
    readToken("balanceOf", [worker.address]),
    readToken("balanceOf", [vault]),
    readToken("totalSupply"),
    publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "spentByDay",
      args: [day],
    }),
  ]);

const wallet = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport,
});
const transactionHash = await wallet.writeContract({
  account: deployer,
  address: vault,
  abi: vaultAbi,
  functionName: "claim",
  args: [receipt, signatures],
  gas: 800_000n,
});
const transactionReceipt = await publicClient.waitForTransactionReceipt({
  hash: transactionHash,
  confirmations: 2,
});
if (transactionReceipt.status !== "success") {
  throw new Error(`Mining claim failed: ${transactionHash}`);
}

const [workerAfter, vaultAfter, supplyAfter, spentAfter, claimedAfter] =
  await Promise.all([
    readToken("balanceOf", [worker.address]),
    readToken("balanceOf", [vault]),
    readToken("totalSupply"),
    publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "spentByDay",
      args: [day],
    }),
    publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "claimedChallenge",
      args: [challengeId],
    }),
  ]);
const rawChecks = [
  ["solution.validated", deterministicValidationPassed, true],
  ["worker.reward", workerAfter - workerBefore, receipt.reward],
  ["vault.debit", vaultBefore - vaultAfter, receipt.reward],
  ["supply.unchanged", supplyAfter, supplyBefore],
  ["day.spent", spentAfter - spentBefore, receipt.reward],
  ["challenge.claimed", claimedAfter, true],
];
const checks = rawChecks.map(([name, actual, expectedValue]) => ({
  name,
  actual: typeof actual === "bigint" ? actual.toString() : actual,
  expected:
    typeof expectedValue === "bigint"
      ? expectedValue.toString()
      : expectedValue,
  passed: actual === expectedValue,
}));
const failures = checks.filter((check) => !check.passed);
const evidence = {
  version: 2,
  chainId,
  network: "Base Sepolia",
  status: failures.length === 0 ? "passed" : "failed",
  challenge,
  solution,
  deterministicValidationPassed,
  receipt: {
    ...receipt,
    baseReward: receipt.baseReward.toString(),
    reward: receipt.reward.toString(),
    day: receipt.day.toString(),
    expiresAt: receipt.expiresAt.toString(),
  },
  validatorSignatures: signatures.length,
  checks,
  transaction: {
    hash: transactionHash,
    blockNumber: transactionReceipt.blockNumber.toString(),
  },
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`Mining smoke test failed ${failures.length} checks`);
}
console.log(
  `Base Sepolia mining smoke passed: 120 APOOL paid to ${worker.address}; ${checks.length} checks.`,
);
console.log(`Smoke evidence: ${outputPath}`);
