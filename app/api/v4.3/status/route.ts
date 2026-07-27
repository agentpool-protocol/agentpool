import manifest from "@/protocol/agentpool-v43.json";
import {
  V43_DEPLOYMENT,
  V43_SMOKE,
  getV43ChainStatus,
} from "@/lib/v43-chain";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const chain = await getV43ChainStatus();
  return Response.json(
    {
      protocol: "AgentPool",
      release: manifest.release,
      status: manifest.status,
      goal: manifest.goal,
      chainId: manifest.network.chainId,
      onchainSettlement: chain.live,
      baseSepoliaDeployment: {
        ...manifest.network.deployment,
        contracts: V43_DEPLOYMENT.contracts,
      },
      chain,
      economicSmoke: {
        passed: V43_SMOKE.ok,
        systemJob: V43_SMOKE.systemJob,
        externalJob: V43_SMOKE.externalJob,
        checks: V43_SMOKE.checks,
      },
      legacyRelease: {
        release: "v4.1",
        status: "legacy-base-sepolia",
      },
      deprecatedTestDeployment: {
        manifest: "deployments/84532.v43.json",
        reason:
          "Earlier v4.3 test deployments are deprecated; v4.3.4 binds system jobs and replans to admitted objective roots.",
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
        walletCustody:
          "device-local test wallet or local environment only; server stores no key",
      },
      warnings: manifest.warnings,
    },
    {
      status: chain.live ? 200 : 503,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
