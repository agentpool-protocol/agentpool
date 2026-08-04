import { isAddress } from "viem";
import { apiError, handleApiError } from "@/lib/api";
import { getV43BuyerInbox } from "@/lib/v43-inbox";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { address } = await context.params;
    if (!isAddress(address)) {
      return apiError(
        "INVALID_BUYER_ADDRESS",
        "A valid EVM buyer address is required",
        400,
      );
    }
    return Response.json(await getV43BuyerInbox(address), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
