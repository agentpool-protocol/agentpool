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
    "base-sepolia-disposable" ||
  requireEnv("V41_WALLET_PROFILE") !== "base-sepolia-disposable"
) {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}

const source = privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"));
const target = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl, { timeout: 30_000, retryCount: 3 });
const client = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({
  account: source,
  chain: baseSepolia,
  transport,
});

if ((await client.getChainId()) !== 84532) {
  throw new Error("BASE_SEPOLIA_ONLY");
}

const desiredBalance = BigInt(
  process.env.V43_TARGET_BALANCE_WEI ?? "135000000000000",
);
const minimumSourceRemainder = BigInt(
  process.env.V41_SOURCE_REMAINDER_WEI ?? "5000000000000",
);
const [sourceBalance, targetBalance] = await Promise.all([
  client.getBalance({ address: source.address }),
  client.getBalance({ address: target.address }),
]);

if (targetBalance >= desiredBalance) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      transferred: false,
      network: "Base Sepolia",
      target: target.address,
      targetTestEth: formatEther(targetBalance),
      reason: "TARGET_ALREADY_FUNDED",
    })}\n`,
  );
  process.exit(0);
}

const value = desiredBalance - targetBalance;
if (sourceBalance <= value + minimumSourceRemainder) {
  throw new Error(
    `SOURCE_TEST_ETH_TOO_LOW:${formatEther(sourceBalance)}:${formatEther(
      value + minimumSourceRemainder,
    )}`,
  );
}

const hash = await wallet.sendTransaction({
  account: source,
  to: target.address,
  value,
});
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  throw new Error(`TEST_ETH_TRANSFER_FAILED:${hash}`);
}

const finalBalance = await client.getBalance({ address: target.address });
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    transferred: true,
    network: "Base Sepolia",
    source: source.address,
    target: target.address,
    transferredTestEth: formatEther(value),
    targetTestEth: formatEther(finalBalance),
    transactionHash: hash,
  })}\n`,
);
