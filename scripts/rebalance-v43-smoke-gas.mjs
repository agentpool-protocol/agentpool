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

const transport = http(requireEnv("AGENTPOOL_RPC_URL"), {
  timeout: 30_000,
  retryCount: 3,
});
const client = createPublicClient({ chain: baseSepolia, transport });
if ((await client.getChainId()) !== 84532) {
  throw new Error("BASE_SEPOLIA_ONLY");
}
const targetRole = process.env.V43_SMOKE_GAS_TARGET?.trim() ?? "worker";
const target =
  targetRole === "resolver"
    ? privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"))
    : privateKeyToAccount(requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY"));
const desired = BigInt(
  process.env.V43_SMOKE_TARGET_WEI ??
    (targetRole === "resolver" ? "5000000000000" : "4000000000000"),
);
const remainder = BigInt(
  process.env.V43_SMOKE_VALIDATOR_REMAINDER_WEI ?? "500000000000",
);
const sources =
  targetRole === "resolver"
    ? [
        "TESTNET_OPERATIONS_PRIVATE_KEY",
        "TESTNET_AUTHOR_PRIVATE_KEY",
        "TESTNET_VALIDATOR_1_PRIVATE_KEY",
        "TESTNET_VALIDATOR_2_PRIVATE_KEY",
        "TESTNET_VALIDATOR_3_PRIVATE_KEY",
      ]
    : [
        "TESTNET_VALIDATOR_1_PRIVATE_KEY",
        "TESTNET_VALIDATOR_2_PRIVATE_KEY",
        "TESTNET_VALIDATOR_3_PRIVATE_KEY",
      ];
const transfers = [];
let targetBalance = await client.getBalance({ address: target.address });
for (const variable of sources) {
  if (targetBalance >= desired) break;
  const source = privateKeyToAccount(requireEnv(variable));
  const sourceBalance = await client.getBalance({
    address: source.address,
  });
  const sourceRemainder =
    variable === "TESTNET_OPERATIONS_PRIVATE_KEY"
      ? 1_500_000_000_000n
      : variable === "TESTNET_AUTHOR_PRIVATE_KEY"
        ? 500_000_000_000n
      : remainder;
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
