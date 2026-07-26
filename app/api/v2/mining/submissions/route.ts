import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, getR2, queryAll, queryFirst } from "@/db/runtime";
import {
  canonicalJson,
  createSignedReward,
  hashJson,
  type MiningChallengePayload,
  type PublicMiningTrack,
} from "@/lib/mining-runtime";
import { DEPLOYMENT } from "@/lib/chain";

const submissionSchema = z.object({
  sessionId: z.string().min(3).max(100),
  challengeId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  minerAgentId: z.string().min(3).max(80),
  recipientAddress: z.string(),
  answer: z.unknown(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const minerAgentId = url.searchParams.get("minerAgentId");
    const rows = minerAgentId
      ? await queryAll(
          `SELECT id, challenge_id, miner_agent_id, recipient_address,
                  submission_hash, accuracy_bps, efficiency_bps, reward_apool,
                  receipt_digest, claim_tx_hash, status, created_at, verified_at, claimed_at
           FROM benchmark_submissions
           WHERE miner_agent_id = ? ORDER BY created_at DESC LIMIT 100`,
          minerAgentId,
        )
      : await queryAll(
          `SELECT id, challenge_id, miner_agent_id, recipient_address,
                  submission_hash, accuracy_bps, efficiency_bps, reward_apool,
                  receipt_digest, claim_tx_hash, status, created_at, verified_at, claimed_at
           FROM benchmark_submissions
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
    const miner = await agentAuthorization(input.minerAgentId, auth.address);
    if (!miner) throw new Error("AUTH_NOT_AGENT_SIGNER");
    const recipient = input.recipientAddress.toLowerCase();
    if (recipient !== miner.ownerAddress && recipient !== miner.delegateAddress) {
      throw new Error("AUTH_RECIPIENT_MISMATCH");
    }
    const session = await queryFirst<{
      challenge_id: string;
      miner_agent_id: string;
      recipient_address: string;
      track: PublicMiningTrack;
      payload_key: string;
      reward_apool: string;
      status: string;
      expires_at: number;
    }>("SELECT * FROM mining_sessions WHERE id = ?", input.sessionId);
    if (
      !session ||
      session.challenge_id.toLowerCase() !== input.challengeId.toLowerCase() ||
      session.miner_agent_id !== input.minerAgentId ||
      session.recipient_address !== recipient ||
      session.status !== "active"
    ) {
      return apiError(
        "CHALLENGE_UNAVAILABLE",
        "The challenge is not assigned to this mining session",
        409,
      );
    }
    if (session.expires_at <= Date.now()) {
      await execute(
        "UPDATE mining_sessions SET status = 'expired' WHERE id = ?",
        input.sessionId,
      );
      return apiError(
        "CHALLENGE_EXPIRED",
        "The challenge submission window has ended",
        409,
      );
    }
    const stored = await getR2().get(session.payload_key);
    if (!stored) {
      return apiError(
        "CHALLENGE_STORAGE_UNAVAILABLE",
        "The private challenge payload is unavailable",
        503,
      );
    }
    const payload = JSON.parse(await stored.text()) as MiningChallengePayload;
    const submissionHash = hashJson(input.answer);
    const id = requestId();
    const artifactKey = `mining/submissions/${id}.json`;
    await getR2().put(artifactKey, canonicalJson(input.answer), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { private: "true", challengeId: input.challengeId },
    });
    const correct =
      canonicalJson(input.answer) === canonicalJson(payload.expectedAnswer);
    const now = Date.now();
    if (!correct) {
      await execute(
        `INSERT INTO benchmark_submissions
          (id, challenge_id, miner_agent_id, recipient_address, submission_hash,
           accuracy_bps, efficiency_bps, reward_apool, artifact_key, status, created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, '0', ?, 'rejected', ?, ?)`,
        id,
        input.challengeId,
        input.minerAgentId,
        recipient,
        submissionHash,
        artifactKey,
        now,
        now,
      );
      await execute(
        "UPDATE mining_sessions SET status = 'rejected' WHERE id = ?",
        input.sessionId,
      );
      const responseBody = {
        id,
        status: "rejected",
        reason: "DETERMINISTIC_VALIDATION_FAILED",
        rewardApool: "0",
      };
      await storeIdempotentResponse({
        key: idempotencyKey,
        actorAddress: auth.address,
        requestHash: auth.requestHash,
        responseBody,
        statusCode: 422,
      });
      return apiResponse(responseBody, 422);
    }

    let signed;
    try {
      signed = await createSignedReward({
        challengeId: input.challengeId as Hex,
        submissionHash,
        minerAgentId: input.minerAgentId,
        recipient: recipient as Address,
        track: session.track,
        baseReward: Number(session.reward_apool),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "VALIDATOR_QUORUM_UNAVAILABLE"
      ) {
        return apiError(
          "VALIDATOR_QUORUM_UNAVAILABLE",
          "Three testnet validator signers are not available",
          503,
        );
      }
      throw error;
    }
    const serializableReceipt = {
      ...signed.receipt,
      baseReward: signed.receipt.baseReward.toString(),
      reward: signed.receipt.reward.toString(),
      day: signed.receipt.day.toString(),
      expiresAt: signed.receipt.expiresAt.toString(),
    };
    const receiptDigest = hashJson(serializableReceipt);
    await execute(
      `INSERT INTO benchmark_submissions
        (id, challenge_id, miner_agent_id, recipient_address, submission_hash,
         accuracy_bps, efficiency_bps, reward_apool, receipt_digest, artifact_key,
         receipt_json, signatures_json, claim_calldata, status, created_at, verified_at)
       VALUES (?, ?, ?, ?, ?, 10000, 0, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
      id,
      input.challengeId,
      input.minerAgentId,
      recipient,
      submissionHash,
      session.reward_apool,
      receiptDigest,
      artifactKey,
      JSON.stringify(serializableReceipt),
      JSON.stringify(signed.signatures),
      signed.calldata,
      now,
      now,
    );
    await execute(
      "UPDATE mining_sessions SET status = 'verified' WHERE id = ?",
      input.sessionId,
    );
    await execute(
      "UPDATE benchmark_challenges SET status = 'verified' WHERE id = ?",
      input.challengeId,
    );
    const responseBody = {
      id,
      status: "verified",
      accuracyBps: 10_000,
      rewardApool: session.reward_apool,
      receipt: serializableReceipt,
      validatorSignatures: signed.signatures,
      claim: {
        to: DEPLOYMENT.contracts.benchmarkRewardVault,
        chainId: DEPLOYMENT.chainId,
        calldata: signed.calldata,
      },
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 201,
    });
    return apiResponse(responseBody, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
