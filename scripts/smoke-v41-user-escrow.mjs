import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";

const root = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  ).abi;

const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const profile = process.env.V41_WALLET_PROFILE?.trim();
const buyerKey = process.env.V41_DEPLOYER_PRIVATE_KEY?.trim();
if (!rpcUrl || profile !== "base-sepolia-disposable" || !buyerKey) {
  throw new Error("V41_USER_ESCROW_SMOKE_REQUIRES_DISPOSABLE_PROFILE");
}

const buyer = privateKeyToAccount(buyerKey);
if (getAddress(buyer.address) !== getAddress(manifest.deployer)) {
  throw new Error("V41_USER_ESCROW_SMOKE_BUYER_MISMATCH");
}
const workerKey = generatePrivateKey();
const worker = privateKeyToAccount(workerKey);
const recoveryDirectory = path.join(root, "outputs", "recovery");
const recoveryPath = path.join(
  recoveryDirectory,
  `v41-user-escrow-worker-${worker.address.toLowerCase()}.json`,
);
fs.mkdirSync(recoveryDirectory, { recursive: true });
fs.writeFileSync(
  recoveryPath,
  `${JSON.stringify({
    network: "Base Sepolia",
    chainId: 84532,
    purpose: "Temporary v4.1 UserEscrow smoke-test recovery",
    worker: worker.address,
    privateKey: workerKey,
    createdAt: new Date().toISOString(),
    transactionHashes: {},
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const buyerClient = createWalletClient({
  account: buyer,
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const workerClient = createWalletClient({
  account: worker,
  chain: baseSepolia,
  transport: http(rpcUrl),
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("V41_USER_ESCROW_SMOKE_CHAIN_MISMATCH");
}

const token = manifest.contracts.token;
const escrow = manifest.contracts.userEscrow;
const verifier = manifest.contracts.objectiveVerifier;
const tokenAbi = artifact("AgentPoolV41Token");
const escrowAbi = artifact("AgentPoolV41UserEscrow");
const budget = parseEther("50");
const bond = parseEther("5");
const deliveryHash = keccak256(toBytes("v4.1-user-escrow-live-delivery"));
const specificationHash = keccak256(
  toBytes("v4.1-user-escrow-live-specification"),
);
const proof = toHex("v4.1 user escrow deterministic proof passed");
const expectedEvidenceHash = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [specificationHash, deliveryHash, keccak256(proof)],
  ),
);
const recipients = [worker.address];
const amounts = [budget];
const deadline = Number((await publicClient.getBlock()).timestamp + 3_600n);
const transactionHashes = {};

async function send(label, client, request) {
  const gasLimit = {
    bondFunding: 100_000n,
    buyerApproval: 100_000n,
    workerApproval: 100_000n,
    fund: 500_000n,
    accept: 250_000n,
    deliver: 250_000n,
    resolve: 600_000n,
    sweep: 100_000n,
  }[label];
  const hash = await client.writeContract({ ...request, gas: gasLimit });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`V41_USER_ESCROW_SMOKE_${label.toUpperCase()}_FAILED:${hash}`);
  }
  transactionHashes[label] = hash;
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  recovery.transactionHashes[label] = hash;
  fs.writeFileSync(
    recoveryPath,
    `${JSON.stringify(recovery, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return receipt;
}

async function waitUntil(label, readValue, accepted) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await readValue();
    if (accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`V41_USER_ESCROW_SMOKE_STATE_TIMEOUT:${label}`);
}

const readJob = (id) =>
  publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [id],
  });
const waitForJobState = (id, state) =>
  waitUntil(
    `job-${id.toString()}-state-${state}`,
    () => readJob(id),
    (job) => Number(job[6]) === state,
  );

const [
  supplyBefore,
  buyerBefore,
  workerBefore,
  escrowBefore,
  jobId,
] = await Promise.all([
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "totalSupply",
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [buyer.address],
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [worker.address],
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [escrow],
  }),
  publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "nextJobId",
  }),
]);
if (buyerBefore < budget + bond) {
  throw new Error("V41_USER_ESCROW_SMOKE_PREFLIGHT_FAILED");
}

const gasFundingHash = await buyerClient.sendTransaction({
  to: worker.address,
  value: parseEther("0.00001"),
});
const gasFundingReceipt = await publicClient.waitForTransactionReceipt({
  hash: gasFundingHash,
});
if (gasFundingReceipt.status !== "success") {
  throw new Error("V41_USER_ESCROW_SMOKE_GAS_FUNDING_FAILED");
}
transactionHashes.gasFunding = gasFundingHash;
{
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  recovery.transactionHashes.gasFunding = gasFundingHash;
  fs.writeFileSync(
    recoveryPath,
    `${JSON.stringify(recovery, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

await send("bondFunding", buyerClient, {
  address: token,
  abi: tokenAbi,
  functionName: "transfer",
  args: [worker.address, bond],
});
await waitUntil(
  "worker-bond-funded",
  () =>
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [worker.address],
    }),
  (balance) => balance === workerBefore + bond,
);
await send("buyerApproval", buyerClient, {
  address: token,
  abi: tokenAbi,
  functionName: "approve",
  args: [escrow, budget],
});
await send("workerApproval", workerClient, {
  address: token,
  abi: tokenAbi,
  functionName: "approve",
  args: [escrow, bond],
});
await send("fund", buyerClient, {
  address: escrow,
  abi: escrowAbi,
  functionName: "fundJob",
  args: [
    worker.address,
    verifier,
    budget,
    bond,
    deadline,
    specificationHash,
    expectedEvidenceHash,
    recipients,
    amounts,
  ],
});
await waitForJobState(jobId, 1);
await send("accept", workerClient, {
  address: escrow,
  abi: escrowAbi,
  functionName: "accept",
  args: [jobId],
});
await waitForJobState(jobId, 2);
await send("deliver", workerClient, {
  address: escrow,
  abi: escrowAbi,
  functionName: "deliver",
  args: [jobId, deliveryHash],
});
await waitForJobState(jobId, 3);
await send("resolve", buyerClient, {
  address: escrow,
  abi: escrowAbi,
  functionName: "resolve",
  args: [jobId, proof, recipients, amounts],
});
await waitForJobState(jobId, 4);

const [supplyAfterSettlement, workerAfterSettlement, escrowAfterSettlement, job] =
  await Promise.all([
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [worker.address],
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [escrow],
    }),
    publicClient.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "jobs",
      args: [jobId],
    }),
  ]);
if (
  supplyAfterSettlement !== supplyBefore ||
  workerAfterSettlement - workerBefore !== budget + bond ||
  escrowAfterSettlement !== escrowBefore ||
  Number(job[6]) !== 4
) {
  throw new Error("V41_USER_ESCROW_SMOKE_SETTLEMENT_INVARIANT_FAILED");
}

await send("sweep", workerClient, {
  address: token,
  abi: tokenAbi,
  functionName: "transfer",
  args: [buyer.address, workerAfterSettlement],
});
await waitUntil(
  "worker-token-sweep",
  () =>
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [worker.address],
    }),
  (balance) => balance === 0n,
);
const [workerFinal, buyerFinal, supplyFinal] = await Promise.all([
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [worker.address],
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [buyer.address],
  }),
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "totalSupply",
  }),
]);
const checks = {
  separateDisposableWorker: worker.address !== buyer.address,
  buyerFundedExistingTokens: buyerBefore >= budget + bond,
  jobSettled: Number(job[6]) === 4,
  externalJobMintedZero: supplyFinal === supplyBefore,
  workerReceivedExactBudgetAndBond:
    workerAfterSettlement - workerBefore === budget + bond,
  escrowPreservedExistingJobs: escrowAfterSettlement === escrowBefore,
  rewardSweptBeforeKeyDiscarded: workerFinal === 0n,
  buyerTokenBalanceRestored: buyerFinal === buyerBefore,
};
if (Object.values(checks).some((passed) => !passed)) {
  throw new Error("V41_USER_ESCROW_SMOKE_FINAL_CHECK_FAILED");
}

const report = {
  version: "4.1.0-alpha",
  network: "Base Sepolia",
  chainId: 84532,
  buyer: buyer.address,
  worker: worker.address,
  workerPrivateKeyRetained: false,
  jobId: jobId.toString(),
  budgetTapool: "50",
  workerBondTapool: "5",
  totalSupplyTapool: (supplyFinal / 10n ** 18n).toString(),
  transactionHashes,
  checks,
  completedAt: new Date().toISOString(),
};
const reportPath = path.join(
  root,
  "deployments",
  "84532.v41.user-escrow-smoke.json",
);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.rmSync(recoveryPath);
process.stdout.write(
  `${JSON.stringify({ ok: true, jobId: report.jobId, checks, reportPath })}\n`,
);
