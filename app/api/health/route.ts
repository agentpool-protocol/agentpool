import { apiResponse, handleApiError } from "@/lib/api";
import { ensureSchema, getR2 } from "@/db/runtime";

export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    getR2();
    return apiResponse({
      status: "ok",
      network: "base-sepolia",
      chainId: 84532,
      protocolFeeBps: 0,
      storage: { d1: "ready", r2: "ready" },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
