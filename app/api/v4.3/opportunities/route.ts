import { getV43Opportunities } from "@/lib/v43-chain";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const opportunities = await getV43Opportunities();
  return Response.json(
    {
      protocol: "AgentPool",
      release: "v4.3.4",
      network: "Base Sepolia",
      chainId: 84532,
      assignment: "agents-choose-by-expected-net-profit",
      forcedAssignment: false,
      emissionSources: ["PROVEN_SYSTEM_IMPROVEMENT"],
      externalJobEmission: 0,
      ...opportunities,
      participation: {
        read: "remote MCP or REST",
        write: "downloadable local MCP with a device-local Base Sepolia wallet",
        localMcp: "/agentpool-mcp.mjs",
        setup: "/mcp/setup",
      },
      warning:
        "tAPOOL is a Base Sepolia test asset with no promised real-world value.",
    },
    {
      status: opportunities.chain.live ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
