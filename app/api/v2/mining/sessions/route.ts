import { isAddress, keccak256, toBytes } from "viem";
import { z } from "zod";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, executeBatch, getR2, queryFirst } from "@/db/runtime";
import {
  baseRewardFor,
  challengeCommitment,
  generateChallenge,
  MAX_ACTIVE_SESSIONS,
  OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL,
  OPERATIONAL_DAILY_CAP_APOOL,
  publicChallenge,
} from "@/lib/mining-runtime";

const sessionSchema = z.object({
  minerAgentId: z.string().min(3).max(80),
  recipientAddress: z.string(),
  track: z.enum(["data", "math", "api"]),
});

function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
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
    const input = sessionSchema.parse(JSON.parse(bodyText));
    if (!isAddress(input.recipientAddress)) {
      throw new Error("AUTH_RECIPIENT_MISMATCH");
    }
    const miner = await agentAuthorization(input.minerAgentId, auth.address);
    if (!miner) throw new Error("AUTH_NOT_AGENT_SIGNER");
    const recipient = input.recipientAddress.toLowerCase();
    if (recipient !== miner.ownerAddress && recipient !== miner.delegateAddress) {
      throw new Error("AUTH_RECIPIENT_MISMATCH");
    }

    const now = Date.now();
    await execute(
      "UPDATE mining_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= ?",
      now,
    );
    const active = await queryFirst<{ count: number; same_track: number }>(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN track = ? THEN 1 ELSE 0 END) AS same_track
       FROM mining_sessions
       WHERE owner_address = ? AND status = 'active' AND expires_at > ?`,
      input.track,
      miner.ownerAddress,
      now,
    );
    if ((active?.count ?? 0) >= MAX_ACTIVE_SESSIONS) {
      return apiError(
        "MINING_SESSION_LIMIT",
        "An owner may have at most three active mining sessions",
        409,
      );
    }
    if ((active?.same_track ?? 0) > 0) {
      return apiError(
        "MINING_TRACK_BUSY",
        "Finish or expire the active session for this track first",
        409,
      );
    }

    const dayStart = utcDayStart(now);
    const [globalUsage, ownerUsage] = await Promise.all([
      queryFirst<{ total: number }>(
        `SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0) AS total
         FROM mining_sessions
         WHERE created_at >= ? AND status IN ('active','submitted','verified','claimed')`,
        dayStart,
      ),
      queryFirst<{ total: number }>(
        `SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0) AS total
         FROM mining_sessions
         WHERE owner_address = ? AND created_at >= ?
           AND status IN ('active','submitted','verified','claimed')`,
        miner.ownerAddress,
        dayStart,
      ),
    ]);
    const rewardApool = baseRewardFor(input.track);
    if ((globalUsage?.total ?? 0) + rewardApool > OPERATIONAL_DAILY_CAP_APOOL) {
      return apiError(
        "MINING_DAILY_CAP_REACHED",
        "The 10,000 APOOL operational mining budget is exhausted for today",
        429,
      );
    }
    if (
      (ownerUsage?.total ?? 0) + rewardApool >
      OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL
    ) {
      return apiError(
        "MINING_ACCOUNT_CAP_REACHED",
        "This owner has reached the 500 APOOL daily mining limit",
        429,
      );
    }

    const id = requestId();
    const challengeId = keccak256(toBytes(id));
    const payload = generateChallenge(input.track, challengeId, now);
    const commitmentHash = challengeCommitment(payload);
    const payloadKey = `mining/challenges/${id}.json`;
    await getR2().put(payloadKey, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { private: "true", challengeId },
    });
    const results = await executeBatch([
      {
        sql: `INSERT INTO mining_sessions
        (id, challenge_id, miner_agent_id, owner_address, recipient_address,
         track, payload_key, assignment_hash, reward_apool, status, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
       WHERE
         (SELECT COUNT(*) FROM mining_sessions
          WHERE owner_address = ? AND status = 'active' AND expires_at > ?) < ?
         AND (SELECT COUNT(*) FROM mining_sessions
              WHERE owner_address = ? AND track = ? AND status = 'active'
                AND expires_at > ?) = 0
         AND (SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0)
              FROM mining_sessions
              WHERE created_at >= ?
                AND status IN ('active','submitted','verified','claimed')) + ? <= ?
         AND (SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0)
              FROM mining_sessions
              WHERE owner_address = ? AND created_at >= ?
                AND status IN ('active','submitted','verified','claimed')) + ? <= ?`,
        bindings: [
          id,
          challengeId,
          input.minerAgentId,
          miner.ownerAddress,
          recipient,
          input.track,
          payloadKey,
          commitmentHash,
          rewardApool.toString(),
          payload.expiresAt,
          now,
          miner.ownerAddress,
          now,
          MAX_ACTIVE_SESSIONS,
          miner.ownerAddress,
          input.track,
          now,
          dayStart,
          rewardApool,
          OPERATIONAL_DAILY_CAP_APOOL,
          miner.ownerAddress,
          dayStart,
          rewardApool,
          OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL,
        ],
      },
      {
        sql: `INSERT INTO benchmark_challenges
          (id, track, league, difficulty, policy_version, commitment_hash,
           base_reward_apool, generator_agent_id, status, reveal_at, expires_at, created_at)
         SELECT ?, ?, 'api', 'standard', 1, ?, ?, 'agentpool-system-v1',
                'assigned', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM mining_sessions WHERE id = ?)`,
        bindings: [
          challengeId,
          input.track === "api" ? "data" : input.track,
          commitmentHash,
          rewardApool.toString(),
          payload.expiresAt,
          payload.expiresAt,
          now,
          id,
        ],
      },
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      await getR2().delete(payloadKey);
      return apiError(
        "MINING_LIMIT_RACE",
        "The session was not created because an active-session or daily limit was reached concurrently",
        409,
      );
    }
    const responseBody = {
      id,
      status: "active",
      ...publicChallenge(payload),
      commitmentHash,
      rewardApool: rewardApool.toString(),
      limits: {
        operationalDailyCapApool: OPERATIONAL_DAILY_CAP_APOOL,
        ownerDailyCapApool: OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL,
        maxActiveSessions: MAX_ACTIVE_SESSIONS,
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
