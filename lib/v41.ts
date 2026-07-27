import { keccak256, toBytes } from "viem";
import deployment from "@/deployments/84532.v41.json";

export const V41 = {
  version: "4.1.0-alpha",
  network: {
    name: "Base Sepolia",
    chainId: 84532,
    settlement: "live-v4.1-contracts",
    contracts: deployment.contracts,
  },
  token: {
    symbol: "tAPOOL",
    maxSupply: "1000000000000",
    decimals: 18,
    premint: "0",
    founderAllocation: "0",
  },
  emission: {
    genesisCapBps: 50,
    genesisDays: 180,
    halfLifeYears: 8,
    epochDays: 7,
    capabilityCapBps: 500,
    experimentalProofCapBps: 100,
    issueCapBps: 1_000,
  },
  markets: ["CAPABILITY", "BASIC", "SYSTEM", "EXTERNAL"] as const,
  fundingSources: {
    CAPABILITY: "CORE_EPOCH",
    BASIC: "CORE_EPOCH",
    SYSTEM: "EVOLUTION_EPOCH",
    EXTERNAL: "USER_ESCROW",
  },
  proof: {
    initialType: "HASH_LOCKED_REPRODUCIBLE_RESULT",
    objectiveOnlyForEmission: true,
    evaluatorCanSetPayout: false,
    subjectiveReserveMining: false,
  },
  fees: {
    protocolFeeBps: 0,
    fixedValidationFee: false,
    fixedRoleSplit: false,
    burnBps: 0,
  },
} as const;

export type V41Market = (typeof V41.markets)[number];

export type V41TaskState =
  | "SPECIFIED"
  | "OPEN"
  | "SOFT_HELD"
  | "AWARDED"
  | "ACCEPTED"
  | "RUNNING"
  | "DELIVERED"
  | "PROOF_PENDING"
  | "SETTLED"
  | "EXPIRED"
  | "DECLINED"
  | "REOPENED"
  | "BUDGET_HOLD"
  | "FAILED"
  | "CHALLENGED"
  | "REJECTED"
  | "AMBIGUOUS"
  | "REPLANNED"
  | "PARTIAL_SETTLED"
  | "REFUNDED";

export const V41_TRANSITIONS: Record<V41TaskState, readonly V41TaskState[]> = {
  SPECIFIED: ["OPEN"],
  OPEN: ["SOFT_HELD", "AWARDED", "EXPIRED"],
  SOFT_HELD: ["AWARDED", "OPEN", "EXPIRED"],
  AWARDED: ["ACCEPTED", "DECLINED", "EXPIRED"],
  ACCEPTED: ["RUNNING", "DECLINED", "EXPIRED"],
  RUNNING: ["DELIVERED", "BUDGET_HOLD", "FAILED", "EXPIRED"],
  DELIVERED: ["PROOF_PENDING"],
  PROOF_PENDING: ["SETTLED", "CHALLENGED", "REJECTED", "AMBIGUOUS"],
  SETTLED: [],
  EXPIRED: [],
  DECLINED: ["REOPENED"],
  REOPENED: ["OPEN", "EXPIRED"],
  BUDGET_HOLD: ["REPLANNED", "PARTIAL_SETTLED", "REFUNDED"],
  FAILED: ["REFUNDED"],
  CHALLENGED: ["SETTLED", "REJECTED", "AMBIGUOUS"],
  REJECTED: ["REFUNDED"],
  AMBIGUOUS: ["REFUNDED"],
  REPLANNED: ["RUNNING", "REFUNDED"],
  PARTIAL_SETTLED: [],
  REFUNDED: [],
};

export function canV41Transition(
  from: V41TaskState,
  to: V41TaskState,
): boolean {
  return V41_TRANSITIONS[from].includes(to);
}

export function expectedNetProfit(input: {
  successProbabilityBps: number;
  expectedPayoutApool: number;
  computeCostApool: number;
  toolCostApool: number;
  gasCostApool: number;
  failureProbabilityBps: number;
  bondLossApool: number;
  verificationCostApool: number;
  subtaskCostApool: number;
  opportunityCostApool: number;
}): number {
  const successValue =
    input.expectedPayoutApool * input.successProbabilityBps / 10_000;
  const expectedBondLoss =
    input.bondLossApool * input.failureProbabilityBps / 10_000;
  return successValue
    - input.computeCostApool
    - input.toolCostApool
    - input.gasCostApool
    - expectedBondLoss
    - input.verificationCostApool
    - input.subtaskCostApool
    - input.opportunityCostApool;
}

export function v41Hash(value: unknown): `0x${string}` {
  return keccak256(toBytes(stableJson(value)));
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function currentV41Epoch(
  now = Date.now(),
  start = deployment.genesisStart * 1_000,
): number {
  return Math.max(0, Math.floor((now - start) / (7 * 24 * 60 * 60 * 1_000)));
}
