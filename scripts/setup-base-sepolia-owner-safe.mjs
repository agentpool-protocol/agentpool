import fs from "node:fs";
import path from "node:path";
import Safe from "@safe-global/protocol-kit";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
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
if (chainId !== 84532) {
  throw new Error("This setup script is Base Sepolia only");
}
if (process.env.AGENTPOOL_WALLET_PROFILE !== "base-sepolia-disposable") {
  throw new Error("A disposable Base Sepolia deployer profile is required");
}
if (process.env.AGENTPOOL_OWNER_PROFILE !== "production") {
  throw new Error("The three real-device public owner addresses are required");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
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
const outputPath = path.join(
  root,
  "deployments",
  "84532.real-device-safe.json",
);
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const managedAccount = (privateKey) =>
  privateKeyToAccount(privateKey, { nonceManager });
const deployerKey = requireEnv("DEPLOYER_PRIVATE_KEY");
const operationsKey = requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY");
const deployer = managedAccount(deployerKey);
const operations = managedAccount(operationsKey);
const owners = [1, 2, 3].map((index) =>
  getAddress(requireEnv(`SAFE_OWNER_${index}`).toLowerCase()),
);
const normalizedOwners = owners.map((owner) => owner.toLowerCase());
if (new Set(normalizedOwners).size !== 3) {
  throw new Error("The desktop, laptop, and phone owners must be distinct");
}
if (deployer.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("Deployer key does not match the Base Sepolia manifest");
}
if (
  operations.address.toLowerCase() !==
  manifest.allocations.operationsTreasury.toLowerCase()
) {
  throw new Error("Operations key does not match the Base Sepolia manifest");
}

const safeAccountConfig = { owners, threshold: 2 };
const safeDeploymentConfig = {
  saltNonce: BigInt(
    keccak256(toBytes("agentpool-base-sepolia-real-device-safe-v1")),
  ).toString(),
  safeVersion: "1.4.1",
};
let safeKit = await Safe.init({
  provider: rpcUrl,
  signer: deployerKey,
  predictedSafe: { safeAccountConfig, safeDeploymentConfig },
});
const safeAddress = await safeKit.getAddress();
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

async function ensureTestEth(address, target, label, gas = 21_000n) {
  const balance = await publicClient.getBalance({ address });
  if (balance >= target) return balance;
  const hash = await deployerWallet.sendTransaction({
    account: deployer,
    to: address,
    value: target - balance,
    gas,
  });
  await waitFor(hash, label);
  return target;
}

let deploymentHash = null;
if (!(await safeKit.isSafeDeployed())) {
  const deployment = await safeKit.createSafeDeploymentTransaction();
  deploymentHash = await deployerWallet.sendTransaction({
    account: deployer,
    to: deployment.to,
    value: BigInt(deployment.value),
    data: deployment.data,
    gas: 1_500_000n,
  });
  await waitFor(deploymentHash, "Safe.deploy.real-device-2-of-3");
}
safeKit = await safeKit.connect({ safeAddress });

const token = manifest.contracts.token;
const tokenAbi = artifact("AgentPoolToken").abi;
const safeTokenTarget = 100n;
const safeTokenBalanceBefore = await publicClient.readContract({
  address: token,
  abi: tokenAbi,
  functionName: "balanceOf",
  args: [safeAddress],
});
if (safeTokenBalanceBefore < safeTokenTarget) {
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
    args: [safeAddress, safeTokenTarget - safeTokenBalanceBefore],
    gas: 100_000n,
  });
  await waitFor(hash, "AgentPoolToken.fund.real-device-safe");
}

const ownerGasTarget = parseEther("0.00001");
const safeEthTarget = parseEther("0.00001");
await ensureTestEth(
  owners[0],
  ownerGasTarget,
  "fund-test-gas.desktop-owner",
);
await ensureTestEth(
  owners[1],
  ownerGasTarget,
  "fund-test-gas.laptop-owner",
);
await ensureTestEth(
  owners[2],
  ownerGasTarget,
  "fund-test-gas.phone-owner",
);
await ensureTestEth(
  safeAddress,
  safeEthTarget,
  "fund-test-eth.safe",
  100_000n,
);

const [deployed, deployedOwners, threshold, nonce, safeCode, tokenBalance, ethBalance] =
  await Promise.all([
    safeKit.isSafeDeployed(),
    safeKit.getOwners(),
    safeKit.getThreshold(),
    safeKit.getNonce(),
    publicClient.getCode({ address: safeAddress }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [safeAddress],
    }),
    publicClient.getBalance({ address: safeAddress }),
  ]);
const actualOwners = deployedOwners
  .map((owner) => owner.toLowerCase())
  .sort();
const expectedOwners = [...normalizedOwners].sort();
const checks = [
  {
    name: "safe.deployed",
    actual: deployed,
    expected: true,
    passed: deployed === true,
  },
  {
    name: "safe.bytecode",
    actual: safeCode !== undefined && safeCode !== "0x",
    expected: true,
    passed: safeCode !== undefined && safeCode !== "0x",
  },
  {
    name: "safe.owners",
    actual: actualOwners,
    expected: expectedOwners,
    passed: JSON.stringify(actualOwners) === JSON.stringify(expectedOwners),
  },
  {
    name: "safe.threshold",
    actual: threshold,
    expected: 2,
    passed: threshold === 2,
  },
  {
    name: "safe.apoolBalance",
    actual: tokenBalance.toString(),
    expectedMinimum: safeTokenTarget.toString(),
    passed: tokenBalance >= safeTokenTarget,
  },
  {
    name: "safe.testEthBalance",
    actual: ethBalance.toString(),
    expectedMinimum: safeEthTarget.toString(),
    passed: ethBalance >= safeEthTarget,
  },
];
const failures = checks.filter((check) => !check.passed);
const evidence = {
  version: 1,
  chainId,
  network: "Base Sepolia",
  status: failures.length === 0 ? "ready_for_two_owner_approval" : "failed",
  safeAddress,
  safeVersion: safeDeploymentConfig.safeVersion,
  owners: {
    desktop: owners[0],
    laptop: owners[1],
    phone: owners[2],
  },
  threshold,
  nonce,
  token,
  apoolBalance: tokenBalance.toString(),
  testEthBalanceWei: ethBalance.toString(),
  suggestedTransfer: {
    asset: "APOOL",
    amount: "10",
    recipient: manifest.allocations.operationsTreasury,
  },
  deploymentHash,
  transactions,
  checks,
  updatedAt: new Date().toISOString(),
  warning: "Base Sepolia test assets only. Do not send mainnet assets.",
};
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`Real-device Safe setup failed ${failures.length} checks`);
}
console.log(`Safe: ${safeAddress}`);
console.log(`Owners: ${owners.join(", ")}`);
console.log(`Policy: 2-of-3`);
console.log(`APOOL balance: ${tokenBalance}`);
console.log(`Test ETH balance (wei): ${ethBalance}`);
console.log(`Evidence: ${outputPath}`);
