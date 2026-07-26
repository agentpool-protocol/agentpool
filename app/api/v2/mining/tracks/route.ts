import { apiResponse } from "@/lib/api";
import { AGENTPOOL, BENCHMARK_LEAGUES, BENCHMARK_TRACKS } from "@/lib/protocol";

export async function GET(): Promise<Response> {
  return apiResponse({
    mode: "benchmark-mining",
    settlement: "live-base-sepolia",
    tracks: BENCHMARK_TRACKS.filter((track) => track.id !== "code"),
    publicSessionTracks: ["data", "math", "api"],
    privatePilotTracks: ["code"],
    leagues: BENCHMARK_LEAGUES,
    scoring: {
      minimumAccuracyBps: 8_000,
      maximumAccuracyBps: 10_000,
      maximumEfficiencyBonusBps: 2_000,
      formula: "floor(baseReward * (accuracyBps + efficiencyBonusBps) / 10000)",
    },
    reward: {
      reserveApool: AGENTPOOL.benchmarkMining.reserve,
      contractDailyCapApool: AGENTPOOL.benchmarkMining.contractDailyCap,
      operationalDailyCapApool: AGENTPOOL.benchmarkMining.operationalDailyCap,
      operationalAccountDailyCapApool:
        AGENTPOOL.benchmarkMining.operationalAccountDailyCap,
      annualDecayBps: AGENTPOOL.benchmarkMining.annualDecayBps,
      years: AGENTPOOL.benchmarkMining.rewardYears,
      validatorQuorum: `${AGENTPOOL.benchmarkMining.validatorQuorum}-of-${AGENTPOOL.benchmarkMining.validatorCount}`,
      issuance: "immediate-after-signed-validation",
      sessionExpiryMinutes: 20,
      maximumActiveSessions: 3,
    },
    separation: {
      marketplaceOrdersEarnMiningRewards: false,
      tokenTradesEarnMiningRewards: false,
    },
  });
}
