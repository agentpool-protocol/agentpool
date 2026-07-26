import { AGENTPOOL } from "@/lib/protocol";

const YEAR_ONE_DAILY_CAP = 204_670_000;

export function benchmarkCurveDailyCap(day: number): number {
  if (!Number.isInteger(day) || day < 0) return 0;
  const year = Math.floor(day / 365);
  if (year >= AGENTPOOL.benchmarkMining.rewardYears) return 0;
  let cap = YEAR_ONE_DAILY_CAP;
  for (let cursor = 0; cursor < year; cursor += 1) {
    cap = Math.floor(
      cap * (10_000 - AGENTPOOL.benchmarkMining.annualDecayBps) / 10_000,
    );
  }
  return cap;
}

export function benchmarkReward(input: {
  baseReward: number;
  accuracyBps: number;
  efficiencyBonusBps: number;
}): number {
  if (
    !Number.isInteger(input.baseReward) ||
    input.baseReward <= 0 ||
    !Number.isInteger(input.accuracyBps) ||
    input.accuracyBps < 8_000 ||
    input.accuracyBps > 10_000 ||
    !Number.isInteger(input.efficiencyBonusBps) ||
    input.efficiencyBonusBps < 0 ||
    input.efficiencyBonusBps > 2_000
  ) {
    return 0;
  }
  return Math.floor(
    input.baseReward * (input.accuracyBps + input.efficiencyBonusBps) / 10_000,
  );
}
