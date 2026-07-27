import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const tokenAbi = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "AgentPoolV41Token.json"), "utf8"),
).abi;
const escrowAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV41UserEscrow.json"),
    "utf8",
  ),
).abi;
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const relayerKey = process.env.V41_DEPLOYER_PRIVATE_KEY?.trim();
if (
  !rpcUrl ||
  !relayerKey ||
  process.env.V41_WALLET_PROFILE?.trim() !== "base-sepolia-disposable"
) {
  throw new Error("V41_LEGACY_REFUND_REQUIRES_DISPOSABLE_PROFILE");
}

const relayer = privateKeyToAccount(relayerKey);
if (getAddress(relayer.address) !== getAddress(manifest.deployer)) {
  throw new Error("V41_LEGACY_REFUND_RELAYER_MISMATCH");
}
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const walletClient = createWalletClient({
  account: relayer,
  chain: baseSepolia,
  transport: http(rpcUrl),
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("V41_LEGACY_REFUND_CHAIN_MISMATCH");
}

const jobId = 1n;
const token = manifest.contracts.token;
const escrow = manifest.contracts.userEscrow;
const job = await publicClient.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: "jobs",
  args: [jobId],
});
const expectedBuyer = getAddress(manifest.deployer);
const expectedBudget = parseEther("100");
const expectedBond = parseEther("10");
const grace = await publicClient.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: "VERIFIER_GRACE",
});
const eligibleAt = BigInt(job[5]) + grace + 1n;
const latestBlock = await publicClient.getBlock();

if (
  getAddress(job[0]) !== expectedBuyer ||
  job[3] !== expectedBudget ||
  job[4] !== expectedBond
) {
  throw new Error("V41_LEGACY_REFUND_JOB_MISMATCH");
}
if (Number(job[6]) === 6) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      alreadyRefunded: true,
      jobId: jobId.toString(),
      buyer: expectedBuyer,
    })}\n`,
  );
  process.exit(0);
}
if (![1, 2, 3].includes(Number(job[6]))) {
  throw new Error(`V41_LEGACY_REFUND_INVALID_STATE:${job[6]}`);
}
if (latestBlock.timestamp < eligibleAt) {
  throw new Error(
    `V41_LEGACY_REFUND_NOT_YET_ELIGIBLE:${new Date(Number(eligibleAt) * 1000).toISOString()}`,
  );
}

const [supplyBefore, buyerBefore, escrowBefore] = await Promise.all([
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "totalSupply",
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [expectedBuyer],
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [escrow],
  }),
]);
const expectedRefund = expectedBudget + expectedBond;
if (escrowBefore < expectedRefund) {
  throw new Error("V41_LEGACY_REFUND_ESCROW_BALANCE_TOO_LOW");
}

const refundHash = await walletClient.writeContract({
  address: escrow,
  abi: escrowAbi,
  functionName: "refundExpired",
  args: [jobId],
  gas: 300_000n,
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash: refundHash,
});
if (receipt.status !== "success") {
  throw new Error(`V41_LEGACY_REFUND_TRANSACTION_FAILED:${refundHash}`);
}

let final;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const [currentJob, supplyAfter, buyerAfter, escrowAfter] = await Promise.all([
    publicClient.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "jobs",
      args: [jobId],
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [expectedBuyer],
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [escrow],
    }),
  ]);
  if (
    Number(currentJob[6]) === 6 &&
    supplyAfter === supplyBefore &&
    buyerAfter === buyerBefore + expectedRefund &&
    escrowAfter === escrowBefore - expectedRefund
  ) {
    final = { supplyAfter, buyerAfter, escrowAfter };
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!final) throw new Error("V41_LEGACY_REFUND_STATE_TIMEOUT");

const evidence = {
  version: "4.1.0-alpha-legacy",
  chainId: 84532,
  jobId: jobId.toString(),
  refundHash,
  buyer: expectedBuyer,
  refundedTapool: formatEther(expectedRefund),
  checks: {
    jobRefunded: true,
    buyerRecoveredBudgetAndBond: true,
    totalSupplyUnchanged: true,
    noNewEmission: true,
  },
  completedAt: new Date().toISOString(),
};
const evidencePath = path.join(
  root,
  "deployments",
  "84532.v41.user-escrow-refund-job-1.json",
);
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ ok: true, refundHash, evidencePath })}\n`,
);
