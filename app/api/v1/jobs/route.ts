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
import {
  validationFeeFor,
  verifierIdForName,
  workerBondFor,
} from "@/lib/protocol";

const jobSchema = z.object({
  listingId: z.string().min(3).max(80),
  buyerAgentId: z.string().min(3).max(80),
  requirementsHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  sellerBondApool: z.string().regex(/^[1-9]\d*$/),
  deadlineAt: z.number().int().positive(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

const publicJobColumns = `id, listing_id, buyer_agent_id, seller_agent_id,
  price_apool, evaluation_budget_apool AS validation_fee_apool, seller_bond_apool,
  state, requirements_hash, delivery_hash, artifact_key, verifier_id, outcome,
  deadline_at, challenge_deadline_at, tx_hash, created_at, updated_at`;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const rows = state
      ? await queryAll(
          `SELECT ${publicJobColumns} FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT 100`,
          state,
        )
      : await queryAll(
          `SELECT ${publicJobColumns} FROM jobs ORDER BY created_at DESC LIMIT 100`,
        );
    return apiResponse({ jobs: rows });
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
    const input = jobSchema.parse(JSON.parse(bodyText));
    const buyer = await agentAuthorization(
      input.buyerAgentId,
      auth.address,
    );
    if (!buyer) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    const listing = await queryFirst<{
      seller_agent_id: string;
      price_apool: string;
      verifier_id: string;
      status: string;
    }>("SELECT seller_agent_id, price_apool, verifier_id, status FROM listings WHERE id = ?", input.listingId);
    if (!listing || listing.status !== "active") {
      return apiError("LISTING_UNAVAILABLE", "The requested listing is not active", 409);
    }
    if (input.deadlineAt <= Date.now()) {
      return apiError("INVALID_DEADLINE", "Job deadline must be in the future", 422);
    }
    const minimumSellerBond = workerBondFor(listing.price_apool);
    if (BigInt(input.sellerBondApool) < minimumSellerBond) {
      return apiError(
        "SELLER_BOND_TOO_LOW",
        `Seller bond must be at least ${minimumSellerBond} APOOL`,
        422,
      );
    }

    const id = requestId();
    const now = Date.now();
    const validationFeeApool = validationFeeFor(listing.price_apool).toString();
    await execute(
      `INSERT INTO jobs
        (id, listing_id, buyer_agent_id, seller_agent_id, price_apool,
         evaluation_budget_apool, seller_bond_apool, state, requirements_hash,
         verifier_id, deadline_at, tx_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_CHAIN', ?, ?, ?, ?, ?, ?)`,
      id,
      input.listingId,
      input.buyerAgentId,
      listing.seller_agent_id,
      listing.price_apool,
      validationFeeApool,
      input.sellerBondApool,
      input.requirementsHash,
      listing.verifier_id,
      input.deadlineAt,
      input.txHash,
      now,
      now,
    );
    const responseBody = {
      id,
      state: "PENDING_CHAIN",
      workerPriceFeeBps: 0,
      validationFeeApool,
      minimumSellerBondApool: minimumSellerBond.toString(),
      validationSplit: {
        validatorsBps: 7000,
        burnBps: 2000,
        securityBps: 1000,
      },
      note: "The chain indexer must confirm the transaction before this job becomes FUNDED.",
      onchainVerifierId: verifierIdForName(listing.verifier_id),
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
