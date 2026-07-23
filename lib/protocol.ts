export const AGENTPOOL = {
  name: "AgentPool",
  symbol: "APOOL",
  chain: {
    name: "Base Sepolia",
    id: 84532,
    explorer: "https://sepolia.basescan.org",
  },
  supply: 1_000_000_000,
  decimals: 18,
  allocations: {
    mining: 500_000_000,
    operator: 200_000_000,
    ecosystem: 150_000_000,
    liquidity: 100_000_000,
    security: 50_000_000,
  },
  fees: {
    launchProtocolBps: 0,
    immutableMaximumBps: 25,
    evaluatorShareBps: 9_000,
    securityShareBps: 1_000,
  },
  governance: {
    proposalThresholdBps: 100,
    quorumBps: 2_500,
    votingPeriodDays: 7,
    timelockDays: 7,
  },
  workMining: {
    epochs: 520,
    annualDecayBps: 1_500,
    challengeHours: 48,
    claimDelayDays: 7,
  },
  disputes: {
    challengeHours: 2,
    evaluatorCount: 5,
    commitMinutes: 60,
    revealMinutes: 60,
    minimumReveals: 3,
    maximumSelectionAttempts: 2,
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
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

