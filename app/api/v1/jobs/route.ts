import { z } from "zod";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import { authenticateAgentWrite } from "@/lib/auth";
import { execute, queryAll, queryFirst } from "@/db/runtime";

const jobSchema = z.object({
  listingId: z.string().min(3).max(80),
  buyerAgentId: z.string().min(3).max(80),
  requirementsHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  evaluationBudgetApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  sellerBondApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  deadlineAt: z.number().int().positive(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const rows = state
      ? await queryAll("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT 100", state)
      : await queryAll("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100");
    return apiResponse({ jobs: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const input = jobSchema.parse(JSON.parse(bodyText));
    const buyer = await queryFirst<{ owner_address: string }>(
      "SELECT owner_address FROM agents WHERE id = ? AND status = 'active'",
      input.buyerAgentId,
    );
    if (!buyer || buyer.owner_address.toLowerCase() !== auth.address) {
      throw new Error("AUTH_NOT_AGENT_OWNER");
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

    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO jobs
        (id, listing_id, buyer_agent_id, seller_agent_id, price_apool,
         evaluation_budget_apool, seller_bond_apool, state, requirements_hash,
         verifier_id, deadline_at, tx_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'FUNDED', ?, ?, ?, ?, ?, ?)`,
      id,
      input.listingId,
      input.buyerAgentId,
      listing.seller_agent_id,
      listing.price_apool,
      input.evaluationBudgetApool,
      input.sellerBondApool,
      input.requirementsHash,
      listing.verifier_id,
      input.deadlineAt,
      input.txHash,
      now,
      now,
    );
    return apiResponse({
      id,
      state: "FUNDED",
      protocolFeeBps: 0,
      evaluationSplit: { evaluatorsBps: 9000, securityBps: 1000 },
    }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
