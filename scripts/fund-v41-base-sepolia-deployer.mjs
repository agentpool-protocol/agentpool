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
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (requireEnv("AGENTPOOL_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("SOURCE_WALLET_MUST_BE_DISPOSABLE_BASE_SEPOLIA");
}
if (requireEnv("V41_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("TARGET_WALLET_MUST_BE_DISPOSABLE_BASE_SEPOLIA");
}

const source = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const target = privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"));
if (source.address.toLowerCase() === target.address.toLowerCase()) {
  throw new Error("V41_DEPLOYER_MUST_BE_FRESH");
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({
  account: source,
  chain: baseSepolia,
  transport,
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("V41_CHAIN_MISMATCH");
}

const desiredBalance = BigInt(
  process.env.V41_TARGET_BALANCE_WEI ?? "200000000000000",
);
const minimumSourceRemainder = BigInt(
  process.env.V41_SOURCE_REMAINDER_WEI ?? "100000000000000",
);
const [sourceBalance, targetBalance] = await Promise.all([
  publicClient.getBalance({ address: source.address }),
  publicClient.getBalance({ address: target.address }),
]);

if (targetBalance >= desiredBalance) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      transferred: false,
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

const hash = await walletClient.sendTransaction({
  account: source,
  to: target.address,
  value,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  throw new Error(`V41_TEST_ETH_TRANSFER_FAILED:${hash}`);
}
let finalBalance = 0n;
for (let attempt = 0; attempt < 10; attempt += 1) {
  finalBalance = await publicClient.getBalance({ address: target.address });
  if (finalBalance >= desiredBalance) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (finalBalance < desiredBalance) {
  throw new Error(`V41_TEST_ETH_BALANCE_NOT_VISIBLE:${hash}`);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    transferred: true,
    network: "Base Sepolia",
    target: target.address,
    targetTestEth: formatEther(finalBalance),
    transactionHash: hash,
  })}\n`,
);
