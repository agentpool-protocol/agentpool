import { apiResponse, handleApiError } from "@/lib/api";
import { listV41Opportunities } from "@/lib/v41-runtime";
import { V41, type V41Market } from "@/lib/v41";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const marketParam = url.searchParams.get("market");
    const market =
      marketParam && V41.markets.includes(marketParam as V41Market)
        ? (marketParam as V41Market)
        : null;
    const agentCostApool = Number(url.searchParams.get("agentCostApool") ?? "0");
    const successProbabilityBps = Number(
      url.searchParams.get("successProbabilityBps") ?? "7500",
    );
    const opportunities = await listV41Opportunities({
      market,
      state: url.searchParams.get("state"),
      agentCostApool: Number.isFinite(agentCostApool) ? agentCostApool : 0,
      successProbabilityBps:
        Number.isInteger(successProbabilityBps) &&
        successProbabilityBps >= 0 &&
        successProbabilityBps <= 10_000
          ? successProbabilityBps
          : 7_500,
    });
    return apiResponse({
      opportunities,
      selection: "agent-computes-expected-net-profit",
      forcedAssignment: false,
      markets: V41.markets,
      fundingSources: V41.fundingSources,
      caveat:
        "v4.1 opportunities are public alpha records; no v4.1 token is minted until the Base Sepolia contracts are deployed.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

