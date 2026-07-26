import { type Address, type Hex } from "viem";
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
import { DEPLOYMENT, verifyTokenTransfer } from "@/lib/chain";

const paymentSchema = z.object({
  listingId: z.string().min(3).max(80),
  buyerAgentId: z.string().min(3).max(80),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

interface DirectListing {
  id: string;
  price_apool: string;
  seller_agent_id: string;
  seller_address: string;
  status: string;
}

async function directListing(listingId: string): Promise<DirectListing | null> {
  return queryFirst<DirectListing>(
    `SELECT listings.id, listings.price_apool, listings.seller_agent_id,
            agents.owner_address AS seller_address, listings.status
     FROM listings
     JOIN agents ON agents.id = listings.seller_agent_id
     WHERE listings.id = ?`,
    listingId,
  );
}

export async function GET(request: Request): Promise<Response> {
  try {
    const listingId = new URL(request.url).searchParams.get("listingId");
    if (!listingId) {
      return apiError("LISTING_REQUIRED", "listingId is required", 422);
    }
    const listing = await directListing(listingId);
    if (!listing || listing.status !== "active") {
      return apiError("LISTING_UNAVAILABLE", "The listing is not active", 404);
    }
    if (BigInt(listing.price_apool) >= 1_000n) {
      return apiError(
        "ESCROW_REQUIRED",
        "Listings of 1,000 APOOL or more use verified escrow",
        409,
      );
    }
    return apiResponse(
      {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: DEPLOYMENT.contracts.token,
            amount: listing.price_apool,
            payTo: listing.seller_address,
            maxTimeoutSeconds: 1_200,
          },
        ],
        validationFeeApool: "0",
        miningEligible: false,
      },
      402,
      { "x-payment-required": "AgentPool-APOOL" },
    );
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
    const input = paymentSchema.parse(JSON.parse(bodyText));
    const buyer = await agentAuthorization(input.buyerAgentId, auth.address);
    if (!buyer) throw new Error("AUTH_NOT_AGENT_SIGNER");
    const listing = await directListing(input.listingId);
    if (!listing || listing.status !== "active") {
      return apiError("LISTING_UNAVAILABLE", "The listing is not active", 404);
    }
    if (BigInt(listing.price_apool) >= 1_000n) {
      return apiError(
        "ESCROW_REQUIRED",
        "Listings of 1,000 APOOL or more use verified escrow",
        409,
      );
    }
    const verified = await verifyTokenTransfer({
      txHash: input.txHash as Hex,
      from: auth.address as Address,
      to: listing.seller_address as Address,
      amount: BigInt(listing.price_apool),
    });
    const now = Date.now();
    const eventId = `84532:${input.txHash.toLowerCase()}:${verified.logIndex}`;
    await execute(
      `INSERT OR IGNORE INTO protocol_events
        (id, type, entity_id, actor_address, payload_json, chain_id,
         block_number, log_index, tx_hash, created_at)
       VALUES (?, 'DirectPayment', ?, ?, ?, 84532, ?, ?, ?, ?)`,
      eventId,
      input.listingId,
      auth.address,
      JSON.stringify({
        buyerAgentId: input.buyerAgentId,
        sellerAgentId: listing.seller_agent_id,
        amountApool: listing.price_apool,
        validationFeeApool: "0",
        miningEligible: false,
      }),
      Number(verified.blockNumber),
      verified.logIndex,
      input.txHash.toLowerCase(),
      now,
    );
    const responseBody = {
      status: "confirmed",
      listingId: input.listingId,
      txHash: input.txHash.toLowerCase(),
      blockNumber: verified.blockNumber.toString(),
      amountApool: listing.price_apool,
      validationFeeApool: "0",
      miningEligible: false,
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
