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
      version: "0.2.0-testnet",
      supplyApool: "1000000000000",
      decimals: 0,
      workerPriceFeeBps: 0,
      validationFeeBps: 300,
      minimumValidationFeeApool: 10,
      workerBondBps: 1000,
      minimumWorkerBondApool: 10,
      verifierProposalTimeoutHours: 72,
      validatorSelectionTimeoutHours: 24,
      buyerPlanApprovalRequired: true,
      validationFeeSplitBps: {
        validators: 7000,
        burn: 2000,
        security: 1000,
      },
      contracts: {
        status: "pending-deployment",
        settlementEnabled: false,
      },
      storage: { d1: "ready", r2: "ready" },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
