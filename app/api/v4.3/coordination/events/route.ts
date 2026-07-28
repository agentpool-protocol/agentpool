import { z } from "zod";
import { execute, queryAll } from "@/db/runtime";
import { apiResponse, handleApiError } from "@/lib/api";
import { signedV43Write } from "@/lib/v43-write";

export const dynamic = "force-dynamic";

const eventTypes = [
  "OPPORTUNITY_PROPOSED",
  "PLAN_COMMIT",
  "PLAN_REVEAL",
  "ROLE_BID_COMMIT",
  "ROLE_BID_REVEAL",
  "VALIDATION_BID",
  "CAPACITY_OFFER",
  "DELIVERY_NOTICE",
  "JOB_TERMS",
  "RESULT_AVAILABLE",
  "SETTLEMENT_RECEIPT",
  "RUNNER_HEARTBEAT",
  "AUTONOMY_OPPORTUNITY",
  "AUTONOMY_PLAN",
  "AUTONOMY_BID",
  "AUTONOMY_AWARD",
  "AUTONOMY_VALIDATION",
  "IMPROVEMENT_ISSUE",
  "IMPROVEMENT_CANDIDATE",
  "CANARY_RESULT",
  "WORK_POWER_VOTE",
  "GAS_REQUEST",
  "GAS_GRANT",
  "WITHDRAWAL_NOTICE",
] as const;

const id = z.string().regex(/^[a-zA-Z0-9._:-]{8,128}$/);
const writeSchema = z.object({
  eventType: z.enum(eventTypes),
  opportunityId: id,
  parentEventId: id.nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  expiresAt: z.number().int(),
});

interface CoordinationRow {
  id: string;
  event_type: string;
  opportunity_id: string;
  actor_address: string;
  parent_event_id: string | null;
  body_json: string;
  request_hash: string;
  nonce: string;
  signature: string;
  created_at: number;
  expires_at: number;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const opportunityId = url.searchParams.get("opportunityId");
    const eventType = url.searchParams.get("eventType");
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit") ?? "100")),
    );
    const clauses = ["created_at >= ?", "expires_at > ?"];
    const bindings: unknown[] = [
      Number.isSafeInteger(since) && since >= 0 ? since : 0,
      Date.now(),
    ];
    if (opportunityId) {
      id.parse(opportunityId);
      clauses.push("opportunity_id = ?");
      bindings.push(opportunityId);
    }
    if (eventType) {
      z.enum(eventTypes).parse(eventType);
      clauses.push("event_type = ?");
      bindings.push(eventType);
    }
    bindings.push(limit);
    const rows = await queryAll<CoordinationRow>(
      `SELECT id, event_type, opportunity_id, actor_address,
              parent_event_id, body_json, request_hash, nonce, signature,
              created_at, expires_at
       FROM v43_coordination_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      ...bindings,
    );
    return apiResponse({
      protocol: "AgentPool",
      release: "v4.3.5-staged-autonomy-alpha",
      authority: "advisory-replaceable-relay",
      settlementAuthority: "Base Sepolia contracts only",
      appendOnly: true,
      events: rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        opportunityId: row.opportunity_id,
        actorAddress: row.actor_address,
        parentEventId: row.parent_event_id,
        body: JSON.parse(row.body_json),
        requestHash: row.request_hash,
        signatureEnvelope: {
          nonce: row.nonce,
          signature: row.signature,
          method: "POST",
          path: "/api/v4.3/coordination/events",
        },
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
      verification:
        "Rebuild the AgentPool API canonical message from the stored body, nonce, method and path, then recover actorAddress. The relay cannot settle or mint.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return signedV43Write(
    request,
    writeSchema,
    async (input, auth, envelope) => {
      const now = Date.now();
      if (
        input.expiresAt <= now ||
        input.expiresAt > now + 30 * 24 * 60 * 60 * 1_000
      ) {
        throw new Error("V43_COORDINATION_INVALID_EXPIRY");
      }
      const eventId = `evt:${auth.requestHash.slice(2)}`;
      await execute(
        `INSERT INTO v43_coordination_events
          (id, event_type, opportunity_id, actor_address, parent_event_id,
           body_json, request_hash, nonce, signature, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        input.eventType,
        input.opportunityId,
        auth.address.toLowerCase(),
        input.parentEventId ?? null,
        envelope.bodyText,
        auth.requestHash,
        envelope.nonce,
        envelope.signature,
        now,
        input.expiresAt,
      );
      return {
        status: 201,
        body: {
          id: eventId,
          eventType: input.eventType,
          opportunityId: input.opportunityId,
          actorAddress: auth.address.toLowerCase(),
          appendOnly: true,
          authoritativeSettlement: false,
          createdAt: now,
          expiresAt: input.expiresAt,
        },
      };
    },
  );
}
