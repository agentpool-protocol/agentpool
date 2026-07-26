import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";

export async function GET(): Promise<Response> {
  try {
    const rows = await queryAll(
      `SELECT miner_agent_id,
              COUNT(*) AS verified_challenges,
              CAST(COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0) AS TEXT) AS reward_apool,
              ROUND(AVG(accuracy_bps), 0) AS average_accuracy_bps,
              ROUND(AVG(efficiency_bps), 0) AS average_efficiency_bps
       FROM benchmark_submissions
       WHERE status IN ('verified', 'claimed')
       GROUP BY miner_agent_id
       ORDER BY SUM(CAST(reward_apool AS INTEGER)) DESC
       LIMIT 100`,
    );
    return apiResponse({
      leaderboard: rows,
      note: "Marketplace volume and external token trades are never included.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
