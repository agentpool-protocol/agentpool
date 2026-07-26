import fs from "node:fs";
import path from "node:path";
import Safe from "@safe-global/protocol-kit";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  nonceManager,
  parseEther,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

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
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.json"), "utf8"),
);
const outputPath = path.join(root, "deployments", "84532.safe-smoke.json");
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const managedAccount = (privateKey) =>
  privateKeyToAccount(privateKey, { nonceManager });
const deployerKey = requireEnv("DEPLOYER_PRIVATE_KEY");
const operationsKey = requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY");
const ownerKeys = Array.from({ length: 5 }, (_, index) =>
  requireEnv(`TESTNET_VALIDATOR_${index + 1}_PRIVATE_KEY`),
);
const deployer = managedAccount(deployerKey);
const operations = managedAccount(operationsKey);
const ownerAccounts = ownerKeys.map((key) => privateKeyToAccount(key));
const owners = ownerAccounts.map((account) => account.address);
if (deployer.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("Deployer private key does not match the deployment manifest");
}
if (
  operations.address.toLowerCase() !==
  manifest.allocations.operationsTreasury.toLowerCase()
) {
  throw new Error("Operations private key does not match the deployment manifest");
}
for (const [index, owner] of owners.entries()) {
  if (owner.toLowerCase() !== manifest.bootstrap.validators[index].toLowerCase()) {
    throw new Error(`Safe owner ${index + 1} does not match validator ${index + 1}`);
  }
}

const safeAccountConfig = { owners, threshold: 3 };
const safeDeploymentConfig = {
  saltNonce: BigInt(
    keccak256(toBytes("agentpool-base-sepolia-operations-safe-v1")),
  ).toString(),
  safeVersion: "1.4.1",
};
let predictedKit = await Safe.init({
  provider: rpcUrl,
  signer: deployerKey,
  predictedSafe: { safeAccountConfig, safeDeploymentConfig },
});
const safeAddress = await predictedKit.getAddress();
const deployerWallet = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport,
});
const transactions = [];
async function waitFor(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
  });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  transactions.push({
    label,
    hash,
    blockNumber: receipt.blockNumber.toString(),
  });
  return receipt;
}
async function ensureGas(account, target) {
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance >= target) return;
  const hash = await deployerWallet.sendTransaction({
    account: deployer,
    to: account.address,
    value: target - balance,
    gas: 21_000n,
  });
  await waitFor(hash, `fund-gas:${account.address}`);
}

let deploymentHash = null;
if (!(await predictedKit.isSafeDeployed())) {
  const deployment = await predictedKit.createSafeDeploymentTransaction();
  deploymentHash = await deployerWallet.sendTransaction({
    account: deployer,
    to: deployment.to,
    value: BigInt(deployment.value),
    data: deployment.data,
    gas: 1_500_000n,
  });
  await waitFor(deploymentHash, "Safe.deploy");
}
const safeKit = await predictedKit.connect({ safeAddress });
const [deployed, deployedOwners, threshold, nonceBefore, safeCode] =
  await Promise.all([
    safeKit.isSafeDeployed(),
    safeKit.getOwners(),
    safeKit.getThreshold(),
    safeKit.getNonce(),
    publicClient.getCode({ address: safeAddress }),
  ]);
if (nonceBefore !== 0) {
  throw new Error(
    `Safe nonce is ${nonceBefore}; refuse to replay the one-time smoke transaction`,
  );
}

const token = manifest.contracts.token;
const tokenAbi = artifact("AgentPoolToken").abi;
const securityTreasury = manifest.allocations.securityTreasury;
const readToken = (functionName, args = []) =>
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName,
    args,
  });
const safeFundingTarget = 100n;
const safeBalanceBeforeFunding = await readToken("balanceOf", [safeAddress]);
if (safeBalanceBeforeFunding < safeFundingTarget) {
  const operationsWallet = createWalletClient({
    account: operations,
    chain: baseSepolia,
    transport,
  });
  const hash = await operationsWallet.writeContract({
    account: operations,
    address: token,
    abi: tokenAbi,
    functionName: "transfer",
    args: [safeAddress, safeFundingTarget - safeBalanceBeforeFunding],
    gas: 100_000n,
  });
  await waitFor(hash, "AgentPoolToken.fundSafe");
}
await ensureGas(managedAccount(ownerKeys[0]), parseEther("0.00005"));

const [safeBalanceBefore, securityBefore, supplyBefore] = await Promise.all([
  readToken("balanceOf", [safeAddress]),
  readToken("balanceOf", [securityTreasury]),
  readToken("totalSupply"),
]);
const transferAmount = 10n;
const transferData = encodeFunctionData({
  abi: tokenAbi,
  functionName: "transfer",
  args: [securityTreasury, transferAmount],
});
let ownerKit = await Safe.init({
  provider: rpcUrl,
  signer: ownerKeys[0],
  safeAddress,
});
let safeTransaction = await ownerKit.createTransaction({
  transactions: [{ to: token, value: "0", data: transferData }],
});
safeTransaction = await ownerKit.signTransaction(safeTransaction);
const secondOwnerKit = await ownerKit.connect({ signer: ownerKeys[1] });
safeTransaction = await secondOwnerKit.signTransaction(safeTransaction);

let twoSignatureRejected = false;
let twoSignatureError = "";
try {
  const unexpectedResult = await ownerKit.executeTransaction(safeTransaction, {
    gasLimit: 800_000n,
  });
  const unexpectedReceipt = await publicClient.waitForTransactionReceipt({
    hash: unexpectedResult.hash,
    confirmations: 2,
  });
  twoSignatureError = `Unexpected receipt status ${unexpectedReceipt.status}`;
} catch (error) {
  twoSignatureRejected = true;
  twoSignatureError = String(error?.shortMessage ?? error?.message ?? error).slice(
    0,
    500,
  );
}
const nonceAfterTwoSignatures = await ownerKit.getNonce();
if (!twoSignatureRejected || nonceAfterTwoSignatures !== 0) {
  throw new Error("Safe did not reject the two-signature execution");
}

const thirdOwnerKit = await ownerKit.connect({ signer: ownerKeys[2] });
safeTransaction = await thirdOwnerKit.signTransaction(safeTransaction);
const safeTransactionHash = await ownerKit.getTransactionHash(safeTransaction);
const executionResult = await ownerKit.executeTransaction(safeTransaction, {
  gasLimit: 800_000n,
});
const executionReceipt = await waitFor(
  executionResult.hash,
  "Safe.execTransaction",
);

const [safeBalanceAfter, securityAfter, supplyAfter, nonceAfter] =
  await Promise.all([
    readToken("balanceOf", [safeAddress]),
    readToken("balanceOf", [securityTreasury]),
    readToken("totalSupply"),
    ownerKit.getNonce(),
  ]);
const normalizedOwners = owners.map((owner) => owner.toLowerCase()).sort();
const normalizedDeployedOwners = deployedOwners
  .map((owner) => owner.toLowerCase())
  .sort();
const rawChecks = [
  ["safe.deployed", deployed, true],
  ["safe.bytecode", safeCode !== undefined && safeCode !== "0x", true],
  [
    "safe.owners",
    JSON.stringify(normalizedDeployedOwners),
    JSON.stringify(normalizedOwners),
  ],
  ["safe.threshold", threshold, 3],
  ["safe.twoSignaturesRejected", twoSignatureRejected, true],
  ["safe.nonceUnchangedAfterReject", nonceAfterTwoSignatures, 0],
  ["safe.threeSignaturesCollected", safeTransaction.signatures.size, 3],
  ["safe.nonceAfterExecution", nonceAfter, 1],
  ["safe.tokenDebit", safeBalanceBefore - safeBalanceAfter, transferAmount],
  ["security.tokenCredit", securityAfter - securityBefore, transferAmount],
  ["token.supplyUnchanged", supplyAfter, supplyBefore],
  ["safe.remainingBalance", safeBalanceAfter, safeFundingTarget - transferAmount],
];
const checks = rawChecks.map(([name, actual, expected]) => ({
  name,
  actual: typeof actual === "bigint" ? actual.toString() : actual,
  expected: typeof expected === "bigint" ? expected.toString() : expected,
  passed: actual === expected,
}));
const failures = checks.filter((check) => !check.passed);
const evidence = {
  version: 1,
  chainId,
  network: "Base Sepolia",
  status: failures.length === 0 ? "passed" : "failed",
  safeAddress,
  safeVersion: safeDeploymentConfig.safeVersion,
  owners,
  threshold,
  deploymentHash,
  twoSignatureRejection: twoSignatureError,
  safeTransactionHash,
  executionTransactionHash: executionResult.hash,
  executionBlockNumber: executionReceipt.blockNumber.toString(),
  checks,
  transactions,
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`Safe smoke test failed ${failures.length} checks`);
}
console.log(
  `Base Sepolia Safe passed: ${safeAddress}, 3-of-5, ${checks.length} checks.`,
);
console.log(`Safe evidence: ${outputPath}`);
