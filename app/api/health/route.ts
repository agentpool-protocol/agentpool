import { apiResponse, handleApiError } from "@/lib/api";
import { ensureSchema, getR2 } from "@/db/runtime";
import { DEPLOYMENT } from "@/lib/chain";
import { V41_DEPLOYMENT } from "@/lib/v41-chain";

export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    getR2();
    return apiResponse({
      status: "ok",
      network: "base-sepolia",
      chainId: 84532,
      version: "0.5.2-v4.1-live",
      versions: {
        v3: {
          status: "legacy-live-base-sepolia",
          supplyApool: "1000000000000",
          decimals: 0,
        },
        v41: {
          status: "alpha-live-base-sepolia",
          maxSupplyApool: "1000000000000",
          premintApool: "0",
          decimals: 18,
          onchainSettlement: true,
          gatewayOnchainWrites: false,
          contracts: V41_DEPLOYMENT.contracts,
        },
      },
      supplyApool: "1000000000000",
      decimals: 0,
      workerPriceFeeBps: 0,
      validationPricing: "fixed-by-verifier",
      validationFeesApool: {
        deterministic: 10,
        sandbox: 30,
        dispute: 50,
      },
      workerBondBps: 1000,
      minimumWorkerBondApool: 10,
      verifierProposalTimeoutHours: 72,
      validatorSelectionTimeoutHours: 24,
      buyerPlanApprovalRequired: true,
      validationFeeSplitBps: {
        validators: 9000,
        burn: 0,
        security: 1000,
      },
      contracts: {
        status: DEPLOYMENT.settlementEnabled ? "live-base-sepolia" : "upgrade-pending",
        settlementEnabled: DEPLOYMENT.settlementEnabled,
        addresses: DEPLOYMENT.contracts,
      },
      storage: { d1: "ready", r2: "ready" },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
