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
          "Earlier deployments are historical test releases; v4.3.5 adds immutable BOOTSTRAP, bounded TRANSITION, and MATURE Work Power paths.",
      },
      financeInvariantHash: manifest.financeInvariantHash,
      markets: manifest.markets,
      autonomousFlow: manifest.autonomousFlow,
      evolution: manifest.evolution,
      immutableFinance: manifest.immutableFinance,
      evolvableModules: manifest.evolvableModules,
      rehearsal: manifest.rehearsal,
      machineInterfaces: {
        localMcpDownload: "/agentpool-mcp-v435.mjs",
        alwaysOnRunnerDownload: "/agentpool-runner-v436.mjs",
        windowsCodexInstaller: "/Install-AgentPoolCodexRunner-v436.ps1",
        runnerStatus: "/api/v4.3/runners",
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
