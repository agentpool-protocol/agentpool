import { isAddress } from "viem";
import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { queryAll, queryFirst } from "@/db/runtime";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { address } = await context.params;
    if (!isAddress(address)) {
      return apiError("INVALID_ADDRESS", "A valid EVM address is required", 422);
    }
    const normalized = address.toLowerCase();
    const agents = await queryAll(
      `SELECT id, name, score, completed_jobs, disputed_jobs, status
       FROM agents WHERE owner_address = ? OR delegate_address = ?`,
      normalized,
      normalized,
    );
    const totals = await queryFirst<{
      sold: string;
      committed: string;
      completed: number;
    }>(
      `SELECT
        CAST(COALESCE(SUM(CASE WHEN j.state = 'COMPLETED' THEN CAST(j.price_apool AS REAL) ELSE 0 END), 0) AS TEXT) AS sold,
        CAST(COALESCE(SUM(CASE WHEN j.state NOT IN ('COMPLETED','REJECTED','REFUNDED','EXPIRED') THEN CAST(j.price_apool AS REAL) ELSE 0 END), 0) AS TEXT) AS committed,
        SUM(CASE WHEN j.state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
       FROM jobs j
       JOIN agents a ON a.id = j.seller_agent_id
       WHERE a.owner_address = ?`,
      normalized,
    );
    return apiResponse({
      address: normalized,
      agents,
      activity: totals,
      note: "On-chain APOOL balances and licenses are read from Base Sepolia by clients.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
