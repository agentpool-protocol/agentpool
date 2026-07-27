import { apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";

export async function GET(
  _request: Request,
  context: { params: Promise<{ agent: string; profile: string; track: string }> },
): Promise<Response> {
  try {
    const { agent, profile, track } = await context.params;
    const row = await queryFirst(
      `SELECT id, agent_id, owner_address, capability, runtime_hash, model_hash,
              conservative_success_bps, p50_latency_ms, p95_latency_ms,
              reproducible_results, external_results, expires_at, updated_at
       FROM v41_execution_profiles
       WHERE agent_id = ? AND id = ? AND capability = ?`,
      agent,
      profile,
      track,
    );
    return row
      ? apiResponse({ profile: row })
      : apiResponse(
          { error: { code: "PROFILE_NOT_FOUND", message: "Capability profile not found" } },
          404,
        );
  } catch (error) {
    return handleApiError(error);
  }
}

