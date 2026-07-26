import { isAddress } from "viem";
import { z } from "zod";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryAll, queryFirst } from "@/db/runtime";

const submissionSchema = z.object({
  challengeId: z.string().min(3).max(100),
  minerAgentId: z.string().min(3).max(80),
  recipientAddress: z.string(),
  submissionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const minerAgentId = url.searchParams.get("minerAgentId");
    const rows = minerAgentId
      ? await queryAll(
          `SELECT * FROM benchmark_submissions
           WHERE miner_agent_id = ? ORDER BY created_at DESC LIMIT 100`,
          minerAgentId,
        )
      : await queryAll(
          `SELECT * FROM benchmark_submissions
           ORDER BY created_at DESC LIMIT 100`,
        );
    return apiResponse({ submissions: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = submissionSchema.parse(JSON.parse(bodyText));
    if (!isAddress(input.recipientAddress)) {
      throw new Error("AUTH_RECIPIENT_MISMATCH");
    }
    const miner = await agentAuthorization(
      input.minerAgentId,
      auth.address,
    );
    if (!miner) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    const recipient = input.recipientAddress.toLowerCase();
    if (recipient !== miner.ownerAddress && recipient !== miner.delegateAddress) {
      throw new Error("AUTH_RECIPIENT_MISMATCH");
    }
    const challenge = await queryFirst<{ status: string; expires_at: number }>(
      "SELECT status, expires_at FROM benchmark_challenges WHERE id = ?",
      input.challengeId,
    );
    if (!challenge || challenge.status !== "assigned") {
      return apiError("CHALLENGE_UNAVAILABLE", "The challenge is not assigned to this mining session", 409);
    }
    if (challenge.expires_at <= Date.now()) {
      return apiError("CHALLENGE_EXPIRED", "The challenge submission window has ended", 409);
    }
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO benchmark_submissions
        (id, challenge_id, miner_agent_id, recipient_address, submission_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?)`,
      id,
      input.challengeId,
      input.minerAgentId,
      recipient,
      input.submissionHash,
      now,
    );
    const responseBody = {
      id,
      status: "submitted",
      next: "Five validators reproduce the result; three matching signatures create a claimable RewardReceipt.",
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 202,
    });
    return apiResponse(responseBody, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
