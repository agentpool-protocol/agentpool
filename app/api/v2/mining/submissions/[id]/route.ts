import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";
import { DEPLOYMENT } from "@/lib/chain";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { id } = await context.params;
    const row = await queryFirst<{
      id: string;
      challenge_id: string;
      miner_agent_id: string;
      recipient_address: string;
      submission_hash: string;
      accuracy_bps: number | null;
      efficiency_bps: number | null;
      reward_apool: string | null;
      receipt_json: string | null;
      signatures_json: string | null;
      claim_calldata: string | null;
      claim_tx_hash: string | null;
      status: string;
      created_at: number;
      verified_at: number | null;
      claimed_at: number | null;
    }>("SELECT * FROM benchmark_submissions WHERE id = ?", id);
    if (!row) {
      return apiError("SUBMISSION_NOT_FOUND", "Mining submission was not found", 404);
    }
    return apiResponse({
      id: row.id,
      challengeId: row.challenge_id,
      minerAgentId: row.miner_agent_id,
      recipientAddress: row.recipient_address,
      submissionHash: row.submission_hash,
      accuracyBps: row.accuracy_bps,
      efficiencyBps: row.efficiency_bps,
      rewardApool: row.reward_apool,
      status: row.status,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
      validatorSignatures: row.signatures_json
        ? JSON.parse(row.signatures_json)
        : null,
      claim:
        row.claim_calldata && row.status === "verified"
          ? {
              chainId: DEPLOYMENT.chainId,
              to: DEPLOYMENT.contracts.benchmarkRewardVault,
              calldata: row.claim_calldata,
            }
          : null,
      claimTxHash: row.claim_tx_hash,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      claimedAt: row.claimed_at,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
