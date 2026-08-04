import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits } from "viem";
import { createV44TestnetParticipant } from "./lib/v44-testnet-participant.mjs";

const WAITING_FOR_ACCEPT = 1;
const WAITING_FOR_DELIVERY = 2;

function parseAllocation(value) {
  try {
    return parseUnits(String(value), 18);
  } catch {
    return 0n;
  }
}

export function selectV44WorkerAction(jobs, nowSeconds) {
  return jobs
    .flatMap((job) =>
      job.milestones.map((milestone) => ({
        jobId: job.jobId,
        jobState: job.state,
        ...milestone,
        allocation: parseAllocation(milestone.allocationTapool),
      })),
    )
    .filter(
      (candidate) =>
        candidate.allocation > 0n &&
        candidate.deadline > nowSeconds &&
        (candidate.state === WAITING_FOR_ACCEPT ||
          candidate.state === WAITING_FOR_DELIVERY),
    )
    .sort(
      (left, right) =>
        (left.allocation === right.allocation
          ? left.deadline - right.deadline
          : left.allocation > right.allocation
            ? -1
            : 1) ||
        left.jobId.localeCompare(right.jobId) ||
        left.index - right.index,
    )[0] ?? null;
}

function objectiveIndexFor(participant, candidate) {
  const index = participant.manifest.bootstrap.objectives.findIndex(
    (objective) =>
      objective.capabilityHash.toLowerCase() ===
        candidate.capabilityHash.toLowerCase() &&
      objective.specificationHash.toLowerCase() ===
        candidate.specificationHash.toLowerCase(),
  );
  if (index < 0) {
    throw new Error("V44_AUTONOMOUS_WORKER_OBJECTIVE_NOT_COMMITTED");
  }
  return index;
}

export async function runV44WorkerCycle(participant, nowSeconds = null) {
  const status = await participant.status();
  const expectedWorker = process.env.V44_BOOTSTRAP_WORKER?.trim();
  if (!participant.account) {
    throw new Error("V44_AUTONOMOUS_WORKER_DEVICE_WALLET_REQUIRED");
  }
  if (
    !expectedWorker ||
    participant.account.address.toLowerCase() !== expectedWorker.toLowerCase()
  ) {
    throw new Error("V44_AUTONOMOUS_WORKER_ADDRESS_MISMATCH");
  }
  if (!status.registered) {
    return { state: "NOT_REGISTERED", status };
  }
  if (status.secondsUntilGenesis > 0) {
    return { state: "WAITING_FOR_GENESIS", status };
  }
  const jobs = await participant.opportunities();
  const candidate = selectV44WorkerAction(
    jobs,
    nowSeconds ?? status.latestTimestamp,
  );
  if (!candidate) {
    return { state: "IDLE_NO_PROFITABLE_ACTION", status, opportunityCount: jobs.length };
  }
  if (candidate.state === WAITING_FOR_ACCEPT) {
    return {
      state: "ACCEPTED",
      jobId: candidate.jobId,
      milestone: candidate.index,
      allocationTapool: candidate.allocationTapool,
      receipt: await participant.accept(candidate.jobId, candidate.index),
    };
  }
  const objectiveIndex = objectiveIndexFor(participant, candidate);
  const delivery = participant.buildDelivery(objectiveIndex);
  return {
    state: "DELIVERED",
    jobId: candidate.jobId,
    milestone: candidate.index,
    objectiveIndex,
    allocationTapool: candidate.allocationTapool,
    deliveryHash: delivery.deliveryHash,
    receipt: await participant.deliver(
      candidate.jobId,
      candidate.index,
      delivery.deliveryHash,
    ),
  };
}

async function main() {
  if (
    process.argv.includes("--mainnet") ||
    Number(process.env.AGENTPOOL_CHAIN_ID ?? 84532) !== 84532
  ) {
    throw new Error("V44_AUTONOMOUS_WORKER_BASE_SEPOLIA_ONLY");
  }
  const watch = process.argv.includes("--watch");
  const pollMs = Math.min(
    300_000,
    Math.max(5_000, Number(process.env.V44_WORKER_POLL_MS ?? 15_000)),
  );
  const maximumRuntimeMs = Math.min(
    21_600_000,
    Math.max(60_000, Number(process.env.V44_WORKER_MAX_RUNTIME_MS ?? 21_600_000)),
  );
  const participant = createV44TestnetParticipant();
  const startedAt = Date.now();
  const outcomes = [];
  do {
    const outcome = await runV44WorkerCycle(participant);
    outcomes.push(outcome);
    if (!watch || outcome.state === "WAITING_FOR_GENESIS") break;
    if (Date.now() - startedAt >= maximumRuntimeMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        testnetOnly: true,
        chainId: 84532,
        campaignId: participant.manifest.campaignId,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
