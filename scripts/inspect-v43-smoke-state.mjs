import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  http,
  keccak256,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath =
  process.env.V43_MANIFEST_PATH ?? "deployments/84532.v43.5.json";
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(root, manifestPath),
    "utf8",
  ),
);
const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts", `${name}.json`),
      "utf8",
    ),
  );
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(
    process.env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org",
    { timeout: 30_000, retryCount: 3 },
  ),
});
const marketAbi = artifact("AgentPoolV432TaskMarket").abi;
const proofAbi = artifact("AgentPoolV432ProofRegistry").abi;
const vaultAbi = artifact("AgentPoolV43EpochVault").abi;
const tokenAbi = artifact("AgentPoolV43Token").abi;
const issueAbi = artifact("AgentPoolV435SystemIssueGate").abi;
const read = (address, abi, functionName, args = []) =>
  client.readContract({ address, abi, functionName, args });
const planHash = keccak256(toBytes("v43-system-improvement-smoke-plan"));
const externalPlanHash = keccak256(toBytes("v43-external-job-smoke-plan"));
const latest = await client.getBlockNumber();
const logs = await client.getContractEvents({
  address: manifest.contracts.taskMarket,
  abi: marketAbi,
  eventName: "JobCreated",
  fromBlock: latest > 2_000n ? latest - 2_000n : 0n,
  toBlock: "latest",
});
const jobLog = logs
  .filter((entry) => entry.args.planHash === planHash)
  .at(-1);
if (!jobLog) throw new Error("SYSTEM_SMOKE_JOB_NOT_FOUND");
const jobId = jobLog.args.jobId;
const externalJobLog = logs
  .filter((entry) => entry.args.planHash === externalPlanHash)
  .at(-1);
const externalJobId = externalJobLog?.args.jobId;
const settledLogs = await client.getContractEvents({
  address: manifest.contracts.taskMarket,
  abi: marketAbi,
  eventName: "MilestoneSettled",
  args: { jobId },
  fromBlock: latest > 2_000n ? latest - 2_000n : 0n,
  toBlock: "latest",
});
const settlementReceipt = settledLogs.at(-1)
  ? await client.getTransactionReceipt({
      hash: settledLogs.at(-1).transactionHash,
    })
  : null;
const roundId = keccak256(
  encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
    ["PROOF", jobId, 0],
  ),
);
const [
  job,
  milestone,
  round,
  ready,
  revealCount,
  groupCount,
  medianScore,
  issueUsage,
  vaultEpoch,
  vaultReserved,
  vaultEmitted,
  totalSupply,
  deployerGas,
  externalJob,
  externalMilestone,
  externalDeposit,
] = await Promise.all([
  read(manifest.contracts.taskMarket, marketAbi, "jobs", [jobId]),
  read(manifest.contracts.taskMarket, marketAbi, "milestones", [jobId, 0]),
  read(manifest.contracts.proofRegistry, proofAbi, "rounds", [roundId]),
  read(manifest.contracts.proofRegistry, proofAbi, "roundReady", [roundId]),
  read(manifest.contracts.proofRegistry, proofAbi, "revealCount", [roundId]),
  read(manifest.contracts.proofRegistry, proofAbi, "groupCount", [roundId]),
  read(manifest.contracts.proofRegistry, proofAbi, "medianScore", [roundId]),
  read(
    manifest.contracts.systemIssueGate,
    issueAbi,
    "usage",
    [manifest.bootstrapIssues[0].issueId],
  ),
  read(
    manifest.contracts.evolutionEpochVault,
    vaultAbi,
    "currentEpoch",
  ),
  read(
    manifest.contracts.evolutionEpochVault,
    vaultAbi,
    "totalReserved",
  ),
  read(
    manifest.contracts.evolutionEpochVault,
    vaultAbi,
    "totalEmitted",
  ),
  read(manifest.contracts.token, tokenAbi, "totalSupply"),
  client.getBalance({ address: manifest.deployer }),
  externalJobId
    ? read(manifest.contracts.taskMarket, marketAbi, "jobs", [
        externalJobId,
      ])
    : null,
  externalJobId
    ? read(manifest.contracts.taskMarket, marketAbi, "milestones", [
        externalJobId,
        0,
      ])
    : null,
  externalJobId
    ? read(
        manifest.contracts.userEscrow,
        artifact("AgentPoolV43UserEscrowKernel").abi,
        "deposits",
        [externalJobId],
      )
    : null,
]);
const externalWorkerProfile = externalMilestone
  ? await read(
      manifest.contracts.contributionLedger,
      artifact("AgentPoolV43ContributionLedger").abi,
      "profiles",
      [externalMilestone[0]],
    )
  : null;
process.stdout.write(
  `${JSON.stringify({
    jobId,
    jobState: Number(job[2]),
    jobBudgetApool: formatUnits(job[6], 18),
    jobPaidApool: formatUnits(job[7], 18),
    milestoneState: Number(milestone[16]),
    round: {
      commitDeadline: Number(round[0]),
      revealDeadline: Number(round[1]),
      ready,
      revealCount: Number(revealCount),
      groupCount: Number(groupCount),
      medianScore: Number(medianScore),
    },
    issueUsage: {
      used: issueUsage[0],
      budgetApool: formatUnits(issueUsage[1], 18),
      candidates: Number(issueUsage[2]),
    },
    evolutionVault: {
      epoch: vaultEpoch.toString(),
      reservedApool: formatUnits(vaultReserved, 18),
      emittedApool: formatUnits(vaultEmitted, 18),
    },
    totalSupplyApool: formatUnits(totalSupply, 18),
    external: externalJob
      ? {
          jobId: externalJobId,
          jobState: Number(externalJob[2]),
          budgetApool: formatUnits(externalJob[6], 18),
          paidApool: formatUnits(externalJob[7], 18),
          milestoneState: Number(externalMilestone[16]),
          worker: externalMilestone[0],
          allocationApool: formatUnits(externalMilestone[7], 18),
          keeperFeeApool: formatUnits(externalMilestone[9], 18),
          depositedApool: formatUnits(externalDeposit[1], 18),
          spentApool: formatUnits(externalDeposit[2], 18),
          escrowClosed: externalDeposit[3],
          workerRegistered: externalWorkerProfile?.[2] ?? null,
        }
      : null,
    deployerTestEth: formatEther(deployerGas),
    settlement: settlementReceipt
      ? {
          transactionHash: settlementReceipt.transactionHash,
          gasUsed: settlementReceipt.gasUsed.toString(),
          effectiveGasPrice: settlementReceipt.effectiveGasPrice.toString(),
          feeTestEth: formatEther(
            settlementReceipt.gasUsed *
              settlementReceipt.effectiveGasPrice,
          ),
        }
      : null,
    now: Math.floor(Date.now() / 1_000),
  }, null, 2)}\n`,
);
