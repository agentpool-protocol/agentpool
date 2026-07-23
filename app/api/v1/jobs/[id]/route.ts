import { z } from "zod";
import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { authenticateAgentWrite } from "@/lib/auth";
import { execute, queryFirst } from "@/db/runtime";
import { canTransition, type JobState } from "@/lib/protocol";

const transitionSchema = z.object({
  state: z.enum(["ACCEPTED", "SUBMITTED", "PROPOSED", "CHALLENGED", "COMPLETED", "REJECTED", "REFUNDED", "EXPIRED"]),
  deliveryHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  artifactKey: z.string().min(3).max(240).optional(),
  outcome: z.enum(["pass", "fail", "ambiguous"]).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const job = await queryFirst("SELECT * FROM jobs WHERE id = ?", id);
    return job ? apiResponse({ job }) : apiError("JOB_NOT_FOUND", "Job was not found", 404);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const input = transitionSchema.parse(JSON.parse(bodyText));
    const job = await queryFirst<{
      state: JobState;
      buyer_owner: string;
      seller_owner: string;
    }>(
      `SELECT j.state,
              buyer.owner_address AS buyer_owner,
              seller.owner_address AS seller_owner
       FROM jobs j
       JOIN agents buyer ON buyer.id = j.buyer_agent_id
       JOIN agents seller ON seller.id = j.seller_agent_id
       WHERE j.id = ?`,
      id,
    );
    if (!job) return apiError("JOB_NOT_FOUND", "Job was not found", 404);
    if (!canTransition(job.state, input.state)) {
      return apiError("INVALID_JOB_TRANSITION", `${job.state} cannot transition to ${input.state}`, 409);
    }
    const sellerStates = new Set(["ACCEPTED", "SUBMITTED", "PROPOSED"]);
    const authorizedOwner = sellerStates.has(input.state) ? job.seller_owner : job.buyer_owner;
    if (authorizedOwner.toLowerCase() !== auth.address) {
      throw new Error("AUTH_NOT_JOB_PARTY");
    }
    if (input.state === "SUBMITTED" && (!input.deliveryHash || !input.artifactKey)) {
      return apiError("DELIVERY_REQUIRED", "A submitted job requires deliveryHash and artifactKey", 422);
    }
    const challengeDeadline =
      input.state === "PROPOSED" ? Date.now() + 2 * 60 * 60 * 1000 : null;
    await execute(
      `UPDATE jobs SET state = ?, delivery_hash = COALESCE(?, delivery_hash),
        artifact_key = COALESCE(?, artifact_key), outcome = COALESCE(?, outcome),
        challenge_deadline_at = COALESCE(?, challenge_deadline_at), updated_at = ?
       WHERE id = ?`,
      input.state,
      input.deliveryHash ?? null,
      input.artifactKey ?? null,
      input.outcome ?? null,
      challengeDeadline,
      Date.now(),
      id,
    );
    return apiResponse({ id, state: input.state, challengeDeadlineAt: challengeDeadline });
  } catch (error) {
    return handleApiError(error);
  }
}
