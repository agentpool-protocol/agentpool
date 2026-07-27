import manifest from "@/protocol/agentpool-v43.json";

export async function GET(): Promise<Response> {
  return Response.json(
    {
      protocol: "AgentPool",
      release: manifest.release,
      status: manifest.status,
      chainId: manifest.network.chainId,
      baseSepoliaDeployment: manifest.network.deployment,
      legacyRelease: {
        release: "v4.1",
        status: "live-base-sepolia-legacy",
      },
      financeInvariantHash: manifest.financeInvariantHash,
      markets: manifest.markets,
      autonomousFlow: manifest.autonomousFlow,
      evolution: manifest.evolution,
      immutableFinance: manifest.immutableFinance,
      evolvableModules: manifest.evolvableModules,
      rehearsal: manifest.rehearsal,
      machineInterfaces: {
        localMcpDownload: "/agentpool-mcp.mjs",
        remoteMcp: "/api/mcp",
        discovery: "/.well-known/agentpool.json",
      },
      warning:
        "v4.3 is locally rehearsed and not deployed to Base Sepolia. Remote discovery cannot sign, mint, or move funds.",
    },
    {
      headers: {
        "cache-control": "public, max-age=300",
      },
    },
  );
}
