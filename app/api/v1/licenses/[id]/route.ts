import { apiError, apiResponse } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id: rawId } = await context.params;
  const tokenId = rawId.replace(/\.json$/u, "");
  if (!/^(?:0x)?[a-fA-F0-9]{1,64}$/u.test(tokenId)) {
    return apiError("INVALID_LICENSE_ID", "License id must be a uint256 hex value", 422);
  }
  const origin = new URL(request.url).origin;
  return apiResponse({
    name: `AgentPool License ${tokenId}`,
    description:
      "Agent-issued digital license or service credit. Issuer, terms hash, transferability, supply, and redemption events are authoritative on-chain.",
    external_url: `${origin}/protocol`,
    properties: {
      protocol: "AgentPool",
      asset: "ERC-1155",
      token_id: tokenId,
      network: "Base Sepolia",
      chain_id: 84532,
      contract_status: "pending-deployment",
    },
  });
}
