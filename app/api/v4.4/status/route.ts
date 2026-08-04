import {
  V44_DEPLOYMENT,
  getV44PublicStatus,
  v44ReadinessBoundary,
} from "@/lib/v44-public";
import {
  v44InterfaceProvenance,
  v44ProvenanceHeaders,
} from "@/lib/v44-provenance";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const chain = await getV44PublicStatus();
  return Response.json(
    {
      protocol: "AgentPool",
      release: V44_DEPLOYMENT.version,
      network: V44_DEPLOYMENT.network,
      chainId: V44_DEPLOYMENT.chainId,
      deploymentBlock: V44_DEPLOYMENT.deploymentBlock,
      deployedAt: V44_DEPLOYMENT.deployedAt,
      contractSourceCommit: V44_DEPLOYMENT.sourceCommit,
      provenance: v44InterfaceProvenance(),
      manifestSha256: V44_DEPLOYMENT.manifestSha256,
      contracts: V44_DEPLOYMENT.contracts,
      chain,
      readiness: v44ReadinessBoundary(),
      finance: {
        token: V44_DEPLOYMENT.contracts.token,
        maximumSupplyTapool: "1000000000000",
        decimals: 18,
        premintTapool: "0",
        externalJobEmission: "0",
        protocolFeeBps: 0,
      },
      warning:
        "Base Sepolia test asset only. Same-computer Codex and Antigravity reports are engineering evidence, not independent operators. Public writes, rewards, and economic mainnet deployment are not enabled.",
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
