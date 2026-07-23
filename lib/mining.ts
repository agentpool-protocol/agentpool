import { AGENTPOOL } from "@/lib/protocol";

const WEEKS_PER_YEAR = 52;
const WEEKLY_RATIO = Math.pow(1 - AGENTPOOL.workMining.annualDecayBps / 10_000, 1 / WEEKS_PER_YEAR);
const WEIGHTS = Array.from(
  { length: AGENTPOOL.workMining.epochs },
  (_, epoch) => Math.pow(WEEKLY_RATIO, epoch),
);
const WEIGHT_TOTAL = WEIGHTS.reduce((sum, value) => sum + value, 0);

export function epochBudget(epoch: number): number {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch >= WEIGHTS.length) {
    return 0;
  }
  return Math.floor((AGENTPOOL.allocations.mining * WEIGHTS[epoch]) / WEIGHT_TOTAL);
}

export function miningContribution(input: {
  netPrice: number;
  categoryCap: number;
  quality: number;
  originality: number;
  demand: number;
  independent: boolean;
}): number {
  if (!input.independent) return 0;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return (
    Math.sqrt(Math.max(0, Math.min(input.netPrice, input.categoryCap))) *
    clamp(input.quality) *
    clamp(input.originality) *
    clamp(input.demand)
  );
}

