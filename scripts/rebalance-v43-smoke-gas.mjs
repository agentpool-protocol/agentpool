import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
function privateKeyFor(name) {
  if (name === "V41_DEPLOYER_PRIVATE_KEY") {
    return (
      process.env.V41_DEPLOYER_PRIVATE_KEY?.trim() ||
      requireEnv("DEPLOYER_PRIVATE_KEY")
    );
  }
  return requireEnv(name);
}
if (
  requireEnv("AGENTPOOL_WALLET_PROFILE") !==
    "base-sepolia-disposable"
) {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}

const transport = http(requireEnv("AGENTPOOL_RPC_URL"), {
  timeout: 30_000,
  retryCount: 3,
});
const client = createPublicClient({ chain: baseSepolia, transport });
if ((await client.getChainId()) !== 84532) {
  throw new Error("BASE_SEPOLIA_ONLY");
}
const targetRole = process.env.V43_SMOKE_GAS_TARGET?.trim() ?? "worker";
const roleVariables = {
  coordinator: "DEPLOYER_PRIVATE_KEY",
  resolver: "V41_DEPLOYER_PRIVATE_KEY",
  worker: "TESTNET_OPERATIONS_PRIVATE_KEY",
  externalWorker: "TESTNET_AUTHOR_PRIVATE_KEY",
  ecosystem: "TESTNET_ECOSYSTEM_PRIVATE_KEY",
  validator1: "TESTNET_VALIDATOR_1_PRIVATE_KEY",
  validator2: "TESTNET_VALIDATOR_2_PRIVATE_KEY",
  validator3: "TESTNET_VALIDATOR_3_PRIVATE_KEY",
};
const targetVariable = roleVariables[targetRole];
if (!targetVariable) throw new Error(`V43_UNKNOWN_GAS_TARGET:${targetRole}`);
const target = privateKeyToAccount(privateKeyFor(targetVariable));
const desired = BigInt(
  process.env.V43_SMOKE_TARGET_WEI ??
    (targetRole === "resolver" ? "5000000000000" : "4000000000000"),
);
const remainder = BigInt(
  process.env.V43_SMOKE_VALIDATOR_REMAINDER_WEI ?? "500000000000",
);
const sources = [
  "V41_DEPLOYER_PRIVATE_KEY",
  "DEPLOYER_PRIVATE_KEY",
  "TESTNET_ECOSYSTEM_PRIVATE_KEY",
  "TESTNET_OPERATIONS_PRIVATE_KEY",
  "TESTNET_AUTHOR_PRIVATE_KEY",
  "TESTNET_VALIDATOR_1_PRIVATE_KEY",
  "TESTNET_VALIDATOR_2_PRIVATE_KEY",
  "TESTNET_VALIDATOR_3_PRIVATE_KEY",
].filter((variable) => variable !== targetVariable);
const transfers = [];
const usedSourceAddresses = new Set();
const fees = await client.estimateFeesPerGas();
const transferGasReserve =
  ((fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 21_000n * 5n) / 4n;
let targetBalance = await client.getBalance({ address: target.address });
for (const variable of sources) {
  if (targetBalance >= desired) break;
  const source = privateKeyToAccount(privateKeyFor(variable));
  if (
    source.address.toLowerCase() === target.address.toLowerCase() ||
    usedSourceAddresses.has(source.address.toLowerCase())
  ) {
    continue;
  }
  usedSourceAddresses.add(source.address.toLowerCase());
  const sourceBalance = await client.getBalance({
    address: source.address,
  });
  const configuredRemainder =
    variable === "V41_DEPLOYER_PRIVATE_KEY" ||
    variable === "DEPLOYER_PRIVATE_KEY"
      ? 700_000_000_000n
      : variable === "TESTNET_ECOSYSTEM_PRIVATE_KEY"
        ? 200_000_000_000n
      : variable === "TESTNET_OPERATIONS_PRIVATE_KEY"
      ? 1_500_000_000_000n
      : variable === "TESTNET_AUTHOR_PRIVATE_KEY"
        ? 500_000_000_000n
        : remainder;
  const sourceRemainder =
    configuredRemainder > transferGasReserve
      ? configuredRemainder
      : transferGasReserve;
  if (sourceBalance <= sourceRemainder) continue;
  const available = sourceBalance - sourceRemainder;
  const value =
    available < desired - targetBalance
      ? available
      : desired - targetBalance;
  const wallet = createWalletClient({
    account: source,
    chain: baseSepolia,
    transport,
  });
  const hash = await wallet.sendTransaction({
    account: source,
    to: target.address,
    value,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`TEST_ETH_TRANSFER_FAILED:${variable}:${hash}`);
  }
  transfers.push({
    source: source.address,
    amountTestEth: formatEther(value),
    transactionHash: hash,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  targetBalance = await client.getBalance({ address: target.address });
}
if (targetBalance < desired) {
  throw new Error(
    `SMOKE_TEST_ETH_INSUFFICIENT:${formatEther(targetBalance)}:${formatEther(
      desired,
    )}`,
  );
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    network: "Base Sepolia",
    targetRole,
    target: target.address,
    targetTestEth: formatEther(targetBalance),
    transfers,
  })}\n`,
);
