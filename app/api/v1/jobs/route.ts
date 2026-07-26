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
  isTemporaryChainError,
  verifyJobFunding,
} from "@/lib/chain";
import {
  validationFeeFor,
  verifierIdForName,
  workerBondFor,
} from "@/lib/protocol";
import { getAddress, type Hex } from "viem";

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
  deadline_at, challenge_deadline_at, tx_hash, chain_job_id, created_at, updated_at`;

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
    if (BigInt(listing.price_apool) < 1_000n) {
      return apiError(
        "DIRECT_PAYMENT_REQUIRED",
        "Jobs below 1,000 APOOL use the direct x402 payment path and are not mining eligible",
        422,
      );
    }
    const minimumSellerBond = workerBondFor(listing.price_apool);
    if (BigInt(input.sellerBondApool) < minimumSellerBond) {
      return apiError(
        "SELLER_BOND_TOO_LOW",
        `Seller bond must be at least ${minimumSellerBond} APOOL`,
        422,
      );
    }

    const seller = await queryFirst<{ owner_address: string }>(
      "SELECT owner_address FROM agents WHERE id = ? AND status = 'active'",
      listing.seller_agent_id,
    );
    if (!seller) {
      return apiError("SELLER_UNAVAILABLE", "The seller agent is not active", 409);
    }
    const validationFeeApool = validationFeeFor(listing.verifier_id).toString();
    const verifierId = verifierIdForName(listing.verifier_id);
    let state = "FUNDED";
    let chainEvidence:
      | { blockNumber: bigint; logIndex: number; onchainJobId: bigint }
      | undefined;
    try {
      chainEvidence = await verifyJobFunding({
        txHash: input.txHash as Hex,
        buyer: getAddress(auth.address),
        seller: getAddress(seller.owner_address),
        price: BigInt(listing.price_apool),
        sellerBond: BigInt(input.sellerBondApool),
        deadline: BigInt(Math.floor(input.deadlineAt / 1_000)),
        requirementsHash: input.requirementsHash as Hex,
        verifierId,
        validationFee: BigInt(validationFeeApool),
      });
    } catch (error) {
      if (!isTemporaryChainError(error)) {
        return apiError(
          "INVALID_CHAIN_TRANSACTION",
          error instanceof Error ? error.message : "Job funding transaction is invalid",
          422,
        );
      }
      state = "PENDING_CHAIN";
    }
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO jobs
        (id, listing_id, buyer_agent_id, seller_agent_id, price_apool,
         evaluation_budget_apool, seller_bond_apool, state, requirements_hash,
         verifier_id, deadline_at, tx_hash, chain_job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.listingId,
      input.buyerAgentId,
      listing.seller_agent_id,
      listing.price_apool,
      validationFeeApool,
      input.sellerBondApool,
      state,
      input.requirementsHash,
      listing.verifier_id,
      input.deadlineAt,
      input.txHash,
      chainEvidence?.onchainJobId.toString() ?? null,
      now,
      now,
    );
    if (chainEvidence) {
      await execute(
        `INSERT INTO protocol_events
          (id, type, entity_id, actor_address, payload_json, chain_id,
           block_number, log_index, tx_hash, created_at)
         VALUES (?, 'JOB_FUNDED', ?, ?, ?, 84532, ?, ?, ?, ?)`,
        requestId(),
        id,
        auth.address,
        JSON.stringify({ onchainJobId: chainEvidence.onchainJobId.toString() }),
        Number(chainEvidence.blockNumber),
        chainEvidence.logIndex,
        input.txHash,
        now,
      );
      await execute(
        `INSERT INTO chain_cursors (chain_id, last_finalized_block, updated_at)
         VALUES (84532, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_finalized_block = MAX(last_finalized_block, excluded.last_finalized_block),
           updated_at = excluded.updated_at`,
        Number(chainEvidence.blockNumber),
        now,
      );
    }
    const responseBody = {
      id,
      state,
      onchainJobId: chainEvidence?.onchainJobId.toString() ?? null,
      workerPriceFeeBps: 0,
      validationFeeApool,
      minimumSellerBondApool: minimumSellerBond.toString(),
      validationSplit: {
        validatorsBps: 9000,
        burnBps: 0,
        securityBps: 1000,
      },
      note:
        state === "FUNDED"
          ? "The exact contract call and JobFunded event were verified on Base Sepolia."
          : "RPC confirmation is pending; the job remains PENDING_CHAIN and is not treated as funded.",
      onchainVerifierId: verifierId,
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: state === "FUNDED" ? 201 : 202,
    });
    return apiResponse(responseBody, state === "FUNDED" ? 201 : 202);
  } catch (error) {
    return handleApiError(error);
  }
}
