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

if (
  requireEnv("AGENTPOOL_WALLET_PROFILE") !==
  "base-sepolia-disposable"
) {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl, { timeout: 30_000, retryCount: 3 });
const client = createPublicClient({ chain: baseSepolia, transport });
if ((await client.getChainId()) !== 84532) {
  throw new Error("BASE_SEPOLIA_ONLY");
}

const target = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const desiredBalance = BigInt(
  process.env.V43_TARGET_BALANCE_WEI ?? "116000000000000",
);
const minimumSourceRemainder = BigInt(
  process.env.V43_PILOT_SOURCE_REMAINDER_WEI ?? "5000000000000",
);
const sourceVariables = [
  "TESTNET_ECOSYSTEM_PRIVATE_KEY",
  "TESTNET_OPERATIONS_PRIVATE_KEY",
  "TESTNET_AUTHOR_PRIVATE_KEY",
  "TESTNET_VALIDATOR_1_PRIVATE_KEY",
  "TESTNET_VALIDATOR_2_PRIVATE_KEY",
  "TESTNET_VALIDATOR_3_PRIVATE_KEY",
];
const transfers = [];
let targetBalance = await client.getBalance({ address: target.address });

for (const variable of sourceVariables) {
  if (targetBalance >= desiredBalance) break;
  const source = privateKeyToAccount(requireEnv(variable));
  const sourceBalance = await client.getBalance({
    address: source.address,
  });
  if (sourceBalance <= minimumSourceRemainder) continue;
  const available = sourceBalance - minimumSourceRemainder;
  const required = desiredBalance - targetBalance;
  const value = available < required ? available : required;
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
  targetBalance = await client.getBalance({ address: target.address });
}

if (targetBalance < desiredBalance) {
  throw new Error(
    `PILOT_TEST_ETH_INSUFFICIENT:${formatEther(targetBalance)}:${formatEther(
      desiredBalance,
    )}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    network: "Base Sepolia",
    target: target.address,
    targetTestEth: formatEther(targetBalance),
    transfers,
  })}\n`,
);
