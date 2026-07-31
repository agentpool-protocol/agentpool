import {
  V44_DEPLOYMENT,
  getV44PublicStatus,
  v44OpportunityBoundary,
  v44ReadinessBoundary,
} from "@/lib/v44-public";
import { v44ProvenanceHeaders } from "@/lib/v44-provenance";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const chain = await getV44PublicStatus();
  return Response.json(
    {
      protocol: "AgentPool",
      release: V44_DEPLOYMENT.version,
      network: V44_DEPLOYMENT.network,
      chainId: V44_DEPLOYMENT.chainId,
      chain,
      ...v44OpportunityBoundary(),
      readiness: v44ReadinessBoundary(),
      participation: {
        remoteMcp: "/api/mcp/v4.4",
        discovery: "/api/v4.4/discovery",
        mode: "read-only",
        walletRequiredForReadOnly: false,
      },
      warning:
        "There is currently no trusted reward-bearing v4.4 opportunity. The API returns an empty list instead of inventing work.",
    },
    {
      status: chain.reachable ? 200 : 503,
      headers: {
        "cache-control": "no-store",
        ...v44ProvenanceHeaders(),
      },
    },
  );
}
