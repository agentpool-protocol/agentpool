import { z } from "zod";
import { apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryAll } from "@/db/runtime";
import { seedReferenceData } from "@/lib/seed";
import {
  BOOTSTRAP_VERIFIER_NAMES,
  verifierIdForName,
} from "@/lib/protocol";

const listingSchema = z.object({
  sellerAgentId: z.string().min(3).max(80),
  title: z.string().min(3).max(120),
  summary: z.string().min(12).max(800),
  assetType: z.enum([
    "code", "image", "video", "dataset", "prompt", "model",
    "api-credit", "service-credit",
  ]),
  priceApool: z.string().regex(/^[1-9]\d*$/),
  licenseType: z.string().min(3).max(80),
  verifierId: z.string().min(3).max(80),
  contentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  resaleAllowed: z.boolean().default(false),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await seedReferenceData();
    const url = new URL(request.url);
    const assetType = url.searchParams.get("assetType");
    const rows = assetType
      ? await queryAll(
          "SELECT * FROM listings WHERE status = 'active' AND asset_type = ? ORDER BY created_at DESC LIMIT 100",
          assetType,
        )
      : await queryAll(
          "SELECT * FROM listings WHERE status = 'active' ORDER BY created_at DESC LIMIT 100",
        );
    return apiResponse({
      listings: rows.map((row) => {
        const listing = row as Record<string, unknown> & { verifier_id: string };
        return {
          ...listing,
          onchain_verifier_id: verifierIdForName(listing.verifier_id),
        };
      }),
    });
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
    const input = listingSchema.parse(JSON.parse(bodyText));
    const seller = await agentAuthorization(
      input.sellerAgentId,
      auth.address,
    );
    if (!seller) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    if (!BOOTSTRAP_VERIFIER_NAMES.includes(input.verifierId)) {
      return apiResponse(
        { error: { code: "UNREGISTERED_VERIFIER", message: "Jobs require a registered v2 verification adapter." } },
        422,
      );
    }

    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO listings
        (id, seller_agent_id, title, summary, asset_type, price_mode,
         price_apool, license_type, verifier_id, content_hash, resale_allowed,
         mining_eligible, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'fixed', ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      input.sellerAgentId,
      input.title,
      input.summary,
      input.assetType,
      input.priceApool,
      input.licenseType,
      input.verifierId,
      input.contentHash ?? null,
      input.resaleAllowed ? 1 : 0,
      0,
      now,
      now,
    );
    const responseBody = {
      id,
      status: "active",
      workerPriceFeeBps: 0,
      benchmarkMiningEligible: false,
      onchainVerifierId: verifierIdForName(input.verifierId),
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
