import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

if (required("AGENTPOOL_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}
const rpcUrl = required("AGENTPOOL_RPC_URL");
const sponsor = privateKeyToAccount(required("DEPLOYER_PRIVATE_KEY"));
const targets = [
  {
    role: "buyer",
    account: privateKeyToAccount(
      required("TESTNET_OPERATIONS_PRIVATE_KEY"),
    ),
    minimumWei: 5_000_000_000_000n,
  },
  {
    role: "worker",
    account: privateKeyToAccount(required("TESTNET_AUTHOR_PRIVATE_KEY")),
    minimumWei: 6_000_000_000_000n,
  },
  {
    role: "validator",
    account: privateKeyToAccount(
      required("TESTNET_VALIDATOR_1_PRIVATE_KEY"),
    ),
    minimumWei: 3_000_000_000_000n,
  },
];
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
assert.equal(await publicClient.getChainId(), 84532);
const walletClient = createWalletClient({
  account: sponsor,
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});

const balancesBefore = new Map(
  await Promise.all(
    targets.map(async ({ role, account }) => [
      role,
      await publicClient.getBalance({ address: account.address }),
    ]),
  ),
);
const deficits = targets.map((target) => ({
  ...target,
  amount:
    target.minimumWei >
    (balancesBefore.get(target.role) ?? 0n)
      ? target.minimumWei -
        (balancesBefore.get(target.role) ?? 0n)
      : 0n,
}));
const total = deficits.reduce((sum, target) => sum + target.amount, 0n);
const maximumTotal = 12_000_000_000_000n;
if (total > maximumTotal) {
  throw new Error(`TESTNET_GAS_GRANT_CAP_EXCEEDED:${total}`);
}
const sponsorBalance = await publicClient.getBalance({
  address: sponsor.address,
});
const sponsorReserve = 5_000_000_000_000n;
if (sponsorBalance < total + sponsorReserve) {
  throw new Error(
    `TESTNET_SPONSOR_BALANCE_TOO_LOW:${formatEther(sponsorBalance)}`,
  );
}

const transfers = [];
for (const target of deficits) {
  if (target.amount === 0n) continue;
  const hash = await walletClient.sendTransaction({
    account: sponsor,
    chain: baseSepolia,
    to: target.account.address,
    value: target.amount,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  transfers.push({
    role: target.role,
    address: target.account.address,
    amountTestEth: formatEther(target.amount),
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
  });
}

const balancesAfter = Object.fromEntries(
  await Promise.all(
    targets.map(async ({ role, account }) => [
      role,
      formatEther(
        await publicClient.getBalance({ address: account.address }),
      ),
    ]),
  ),
);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    chainId: 84532,
    testnetOnly: true,
    sponsorAddress: sponsor.address,
    transfers,
    balancesAfter,
  })}\n`,
);
