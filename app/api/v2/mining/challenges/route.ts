import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const track = url.searchParams.get("track");
    const rows = track
      ? await queryAll(
          `SELECT id, track, league, difficulty, policy_version, commitment_hash,
                  base_reward_apool, status, reveal_at, expires_at, created_at
           FROM benchmark_challenges
           WHERE track = ?
           ORDER BY created_at DESC LIMIT 100`,
          track,
        )
      : await queryAll(
          `SELECT id, track, league, difficulty, policy_version, commitment_hash,
                  base_reward_apool, status, reveal_at, expires_at, created_at
           FROM benchmark_challenges
           ORDER BY created_at DESC LIMIT 100`,
        );
    return apiResponse({
      challenges: rows,
      privacy: "Only commitments are public until each challenge reveal time.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
