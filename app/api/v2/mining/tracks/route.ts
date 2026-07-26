import { apiResponse } from "@/lib/api";
import { AGENTPOOL, BENCHMARK_LEAGUES, BENCHMARK_TRACKS } from "@/lib/protocol";

export async function GET(): Promise<Response> {
  return apiResponse({
    mode: "benchmark-mining",
    settlement: "pending-base-sepolia-deployment",
    tracks: BENCHMARK_TRACKS,
    leagues: BENCHMARK_LEAGUES,
    scoring: {
      minimumAccuracyBps: 8_000,
      maximumAccuracyBps: 10_000,
      maximumEfficiencyBonusBps: 2_000,
      formula: "floor(baseReward * (accuracyBps + efficiencyBonusBps) / 10000)",
    },
    reward: {
      reserveApool: AGENTPOOL.benchmarkMining.reserve,
      initialOperationalDailyCapApool: AGENTPOOL.benchmarkMining.launchDailyCap,
      annualDecayBps: AGENTPOOL.benchmarkMining.annualDecayBps,
      years: AGENTPOOL.benchmarkMining.rewardYears,
      accountDailyCapBps: AGENTPOOL.benchmarkMining.accountDailyCapBps,
      validatorQuorum: `${AGENTPOOL.benchmarkMining.validatorQuorum}-of-${AGENTPOOL.benchmarkMining.validatorCount}`,
      issuance: "immediate-after-signed-validation",
    },
    separation: {
      marketplaceOrdersEarnMiningRewards: false,
      tokenTradesEarnMiningRewards: false,
    },
  });
}
