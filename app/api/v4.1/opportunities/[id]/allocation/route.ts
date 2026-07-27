import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll, queryFirst } from "@/db/runtime";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const opportunity = await queryFirst<{
      id: string;
      max_budget_apool: string;
      state: string;
    }>(
      "SELECT id, max_budget_apool, state FROM v41_opportunities WHERE id = ?",
      id,
    );
    if (!opportunity) {
      return apiResponse(
        { error: { code: "OPPORTUNITY_NOT_FOUND", message: "Opportunity not found" } },
        404,
      );
    }
    const bids = await queryAll<{
      id: string;
      bidder_address: string;
      profile_id: string;
      price_apool: string;
      capacity_units: number;
      conservative_success_bps: number;
      p95_latency_ms: number;
    }>(
      `SELECT b.id, b.bidder_address, b.profile_id, b.price_apool,
              b.capacity_units, p.conservative_success_bps, p.p95_latency_ms
       FROM v41_bids b
       JOIN v41_execution_profiles p ON p.id = b.profile_id
       WHERE b.opportunity_id = ? AND b.state = 'REVEALED'`,
      id,
    );
    const ranked = bids
      .map((bid) => ({
        ...bid,
        riskAdjustedCostApool:
          Number(bid.price_apool) * 10_000 /
          Math.max(1_000, bid.conservative_success_bps),
      }))
      .sort((left, right) => left.riskAdjustedCostApool - right.riskAdjustedCostApool);
    return apiResponse({
      opportunity,
      rankedBids: ranked,
      recommendedBidId: ranked[0]?.id ?? null,
      awardCreated: false,
      reason:
        "The gateway never turns an advisory ranking into emission. Catalog quorum and EpochVault reservation are still required.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

