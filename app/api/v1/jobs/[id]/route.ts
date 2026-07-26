import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const job = await queryFirst(
      `SELECT id, listing_id, buyer_agent_id, seller_agent_id, price_apool,
              evaluation_budget_apool AS validation_fee_apool, seller_bond_apool,
              state, requirements_hash, delivery_hash, artifact_key, verifier_id,
              outcome, deadline_at, challenge_deadline_at, tx_hash, created_at, updated_at
       FROM jobs WHERE id = ?`,
      id,
    );
    return job ? apiResponse({ job }) : apiError("JOB_NOT_FOUND", "Job was not found", 404);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const job = await queryFirst("SELECT id, state FROM jobs WHERE id = ?", id);
    if (!job) return apiError("JOB_NOT_FOUND", "Job was not found", 404);
    return apiError(
      "CHAIN_STATE_AUTHORITATIVE",
      "Job states are indexed from confirmed escrow events and cannot be mutated through the API.",
      409,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
