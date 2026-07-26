import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { apiError, apiResponse, handleApiError } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryFirst } from "@/db/runtime";
import { verifyBenchmarkClaim } from "@/lib/chain";

const claimSchema = z.object({
  submissionId: z.string().min(3).max(100),
  minerAgentId: z.string().min(3).max(80),
});

type RouteContext = { params: Promise<{ txHash: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { txHash } = await context.params;
    if (!/^0x[a-fA-F0-9]{64}$/u.test(txHash)) {
      return apiError("INVALID_TX_HASH", "Claim transaction hash is invalid", 422);
    }
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = claimSchema.parse(JSON.parse(bodyText));
    const miner = await agentAuthorization(input.minerAgentId, auth.address);
    if (!miner) throw new Error("AUTH_NOT_AGENT_SIGNER");
    const submission = await queryFirst<{
      challenge_id: string;
      miner_agent_id: string;
      recipient_address: string;
      reward_apool: string;
      receipt_json: string;
      status: string;
    }>(
      `SELECT challenge_id, miner_agent_id, recipient_address, reward_apool,
              receipt_json, status
       FROM benchmark_submissions WHERE id = ?`,
      input.submissionId,
    );
    if (!submission || submission.miner_agent_id !== input.minerAgentId) {
      return apiError("SUBMISSION_NOT_FOUND", "Mining submission was not found", 404);
    }
    if (submission.status === "claimed") {
      return apiError("CLAIM_ALREADY_CONFIRMED", "This reward is already claimed", 409);
    }
    if (submission.status !== "verified" || !submission.receipt_json) {
      return apiError("CLAIM_NOT_READY", "The reward receipt is not ready", 409);
    }
    if (!isAddress(submission.recipient_address)) {
      throw new Error("INVALID_CLAIM_RECIPIENT");
    }
    const receipt = JSON.parse(submission.receipt_json) as {
      minerId: Hex;
    };
    const verified = await verifyBenchmarkClaim({
      txHash: txHash as Hex,
      challengeId: submission.challenge_id as Hex,
      minerId: receipt.minerId,
      recipient: submission.recipient_address as Address,
      reward: BigInt(submission.reward_apool),
    });
    const now = Date.now();
    await execute(
      `UPDATE benchmark_submissions
       SET status = 'claimed', claim_tx_hash = ?, claimed_at = ?
       WHERE id = ? AND status = 'verified'`,
      txHash.toLowerCase(),
      now,
      input.submissionId,
    );
    await execute(
      `UPDATE mining_sessions SET status = 'claimed'
       WHERE challenge_id = ?`,
      submission.challenge_id,
    );
    await execute(
      `INSERT OR IGNORE INTO protocol_events
        (id, type, entity_id, actor_address, payload_json, chain_id,
         block_number, log_index, tx_hash, created_at)
       VALUES (?, 'BenchmarkRewardClaimed', ?, ?, ?, 84532, ?, ?, ?, ?)`,
      `84532:${txHash.toLowerCase()}:${verified.logIndex}`,
      input.submissionId,
      submission.recipient_address,
      JSON.stringify({ rewardApool: submission.reward_apool }),
      Number(verified.blockNumber),
      verified.logIndex,
      txHash.toLowerCase(),
      now,
    );
    await execute(
      `INSERT INTO chain_cursors (chain_id, last_finalized_block, updated_at)
       VALUES (84532, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET
         last_finalized_block = MAX(last_finalized_block, excluded.last_finalized_block),
         updated_at = excluded.updated_at`,
      Number(verified.blockNumber),
      now,
    );
    const responseBody = {
      submissionId: input.submissionId,
      status: "claimed",
      txHash: txHash.toLowerCase(),
      blockNumber: verified.blockNumber.toString(),
      rewardApool: submission.reward_apool,
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 200,
    });
    return apiResponse(responseBody);
  } catch (error) {
    return handleApiError(error);
  }
}
