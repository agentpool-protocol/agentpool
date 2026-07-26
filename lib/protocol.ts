import { keccak256, toBytes } from "viem";
import protocolConfig from "@/protocol-config.json";

export const BOOTSTRAP_VERIFIER_NAMES =
  protocolConfig.bootstrapVerifierNames as readonly string[];

export function verifierIdForName(name: string): `0x${string}` {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(name)) {
    throw new Error("Verifier names must use 3-80 lowercase letters, numbers, or hyphens");
  }
  return keccak256(toBytes(name));
}

export const AGENTPOOL = {
  name: "AgentPool",
  symbol: "APOOL",
  chain: {
    name: "Base Sepolia",
    id: 84532,
    explorer: "https://sepolia.basescan.org",
  },
  supply: 1_000_000_000_000,
  decimals: 0,
  allocations: {
    benchmarkRewards: 400_000_000_000,
    ecosystem: 200_000_000_000,
    operations: 100_000_000_000,
    validators: 60_000_000_000,
    taskAuthors: 40_000_000_000,
    liquidity: 100_000_000_000,
    founderVesting: 50_000_000_000,
    security: 50_000_000_000,
  },
  fees: {
    jobSettlementBps: 0,
    mutable: false,
    validationFeeBps: 300,
    minimumValidationFeeApool: 10,
    validatorShareBps: 7_000,
    burnShareBps: 2_000,
    securityShareBps: 1_000,
    workerBondBps: 1_000,
    minimumWorkerBondApool: 10,
  },
  governance: {
    proposalThresholdBps: 25,
    quorumBps: 1_000,
    votingPeriodDays: 7,
    timelockDays: 7,
  },
  benchmarkMining: {
    reserve: 400_000_000_000,
    rewardYears: 10,
    annualDecayBps: 1_500,
    launchDailyCap: 1_000_000,
    accountDailyCapBps: 50,
    validatorCount: 5,
    validatorQuorum: 3,
    tracks: {
      code: 4_000,
      data: 3_000,
      math: 3_000,
    },
    leagues: {
      container: 5_000,
      api: 5_000,
    },
  },
  projects: {
    maxTasks: 32,
    stagePaymentBps: 8_000,
    holdbackBps: 2_000,
    buyerPlanApprovalRequired: true,
    merkleProofRequired: true,
    dependenciesEnforcedOnchain: true,
  },
  disputes: {
    challengeHours: 2,
    verifierProposalTimeoutHours: 72,
    selectionTimeoutHours: 24,
    evaluatorCount: 5,
    commitMinutes: 60,
    revealMinutes: 60,
    minimumReveals: 3,
    selection: "bounded-without-replacement",
  },
} as const;

export type JobState =
  | "OPEN"
  | "FUNDED"
  | "ACCEPTED"
  | "SUBMITTED"
  | "PROPOSED"
  | "CHALLENGED"
  | "COMPLETED"
  | "REJECTED"
  | "REFUNDED"
  | "EXPIRED";

export type AssetType =
  | "code"
  | "image"
  | "video"
  | "dataset"
  | "prompt"
  | "model"
  | "api-credit"
  | "service-credit";

export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  OPEN: ["FUNDED", "EXPIRED"],
  FUNDED: ["ACCEPTED", "REFUNDED", "EXPIRED"],
  ACCEPTED: ["SUBMITTED", "REFUNDED", "EXPIRED"],
  SUBMITTED: ["PROPOSED", "REFUNDED"],
  PROPOSED: ["CHALLENGED", "COMPLETED", "REJECTED", "REFUNDED"],
  CHALLENGED: ["COMPLETED", "REJECTED", "REFUNDED"],
  COMPLETED: [],
  REJECTED: [],
  REFUNDED: [],
  EXPIRED: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function formatApool(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function validationFeeFor(value: string | number | bigint): bigint {
  const amount = BigInt(value);
  if (amount <= 0n) return 0n;
  const percentageFee =
    (amount * BigInt(AGENTPOOL.fees.validationFeeBps) + 9_999n) / 10_000n;
  return percentageFee < BigInt(AGENTPOOL.fees.minimumValidationFeeApool)
    ? BigInt(AGENTPOOL.fees.minimumValidationFeeApool)
    : percentageFee;
}

export function workerBondFor(value: string | number | bigint): bigint {
  const amount = BigInt(value);
  if (amount <= 0n) return 0n;
  const percentageBond =
    (amount * BigInt(AGENTPOOL.fees.workerBondBps) + 9_999n) / 10_000n;
  return percentageBond < BigInt(AGENTPOOL.fees.minimumWorkerBondApool)
    ? BigInt(AGENTPOOL.fees.minimumWorkerBondApool)
    : percentageBond;
}

export function validationReserveFor(
  maxWorkerBudget: string | number | bigint,
  maxTasks: number,
): bigint {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > AGENTPOOL.projects.maxTasks) {
    throw new Error("Project maxTasks must be between 1 and 32");
  }
  const budget = BigInt(maxWorkerBudget);
  if (budget < BigInt(maxTasks)) {
    throw new Error("Project worker budget must fund at least one APOOL per possible task");
  }
  const smallTaskReserve =
    BigInt(maxTasks - 1) * BigInt(AGENTPOOL.fees.minimumValidationFeeApool);
  const largestTaskBudget = budget - BigInt(maxTasks - 1);
  return smallTaskReserve + validationFeeFor(largestTaskBudget);
}

export const BENCHMARK_TRACKS = [
  {
    id: "code",
    shareBps: 4_000,
    description: "Sandboxed code repair and implementation with hidden tests.",
  },
  {
    id: "data",
    shareBps: 3_000,
    description: "Deterministic JSON, CSV, schema, normalization, and aggregation tasks.",
  },
  {
    id: "math",
    shareBps: 3_000,
    description: "Generated mathematics and logic with machine-checkable answers.",
  },
] as const;

export const BENCHMARK_LEAGUES = [
  {
    id: "container",
    shareBps: 5_000,
    description: "Network-isolated reproducible container execution.",
  },
  {
    id: "api",
    shareBps: 5_000,
    description: "Nonce-bound remote endpoint evaluation.",
  },
] as const;
