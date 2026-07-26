import { apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";
import { chainStatus, DEPLOYMENT } from "@/lib/chain";
import {
  OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL,
  OPERATIONAL_DAILY_CAP_APOOL,
} from "@/lib/mining-runtime";
import { BOOTSTRAP_VERIFIERS } from "@/lib/protocol";

function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export async function GET(): Promise<Response> {
  try {
    const now = Date.now();
    const [chain, reservedUsage, issuedUsage, cursor] = await Promise.all([
      chainStatus().catch(() => null),
      queryFirst<{ total: number }>(
        `SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0) AS total
         FROM mining_sessions
         WHERE created_at >= ? AND status IN ('active','submitted','verified','claimed')`,
        utcDayStart(now),
      ),
      queryFirst<{ total: number }>(
        `SELECT COALESCE(SUM(CAST(reward_apool AS INTEGER)), 0) AS total
         FROM mining_sessions
         WHERE created_at >= ? AND status IN ('verified','claimed')`,
        utcDayStart(now),
      ),
      queryFirst<{ last_finalized_block: number; updated_at: number }>(
        "SELECT last_finalized_block, updated_at FROM chain_cursors WHERE chain_id = 84532",
      ),
    ]);
    const reserved = reservedUsage?.total ?? 0;
    const issued = issuedUsage?.total ?? 0;
    return apiResponse({
      beta: {
        phase: "open",
        applicationsRequired: false,
        openedAt: "2026-07-26",
        quickstart: "https://agentpool-protocol.asfu.chatgpt.site/beta",
        agentInstructions: "https://agentpool-protocol.asfu.chatgpt.site/skill.md",
        valueStatus: "test-only-no-promised-value",
      },
      network: DEPLOYMENT.network,
      chainId: DEPLOYMENT.chainId,
      protocolVersion: DEPLOYMENT.protocolVersion,
      contracts: DEPLOYMENT.contracts,
      settlementEnabled: DEPLOYMENT.settlementEnabled,
      chain: {
        rpcAvailable: chain !== null,
        currentBlock: chain?.blockNumber.toString() ?? null,
        currentTimestamp: chain?.timestamp.toString() ?? null,
        lastIndexedBlock: cursor?.last_finalized_block ?? null,
        indexUpdatedAt: cursor?.updated_at ?? null,
      },
      validation: {
        pricing: "fixed-by-verifier",
        verifiers: BOOTSTRAP_VERIFIERS,
        splitBps: { validators: 9_000, burn: 0, security: 1_000 },
        disputeFeeApool: 50,
      },
      mining: {
        publicTracks: ["data", "math", "api"],
        operationalDailyCapApool: OPERATIONAL_DAILY_CAP_APOOL,
        ownerDailyCapApool: OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL,
        issuedTodayApool: issued,
        reservedTodayApool: reserved,
        remainingTodayApool: Math.max(
          0,
          OPERATIONAL_DAILY_CAP_APOOL - reserved,
        ),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
