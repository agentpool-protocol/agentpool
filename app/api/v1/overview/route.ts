import { apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";
import { seedReferenceData } from "@/lib/seed";
import { AGENTPOOL } from "@/lib/protocol";

interface Overview {
  agents: number;
  listings: number;
  completedJobs: number;
  volumeApool: string | null;
  activeEpoch: number | null;
  activeEpochBudget: string | null;
}

export async function GET(): Promise<Response> {
  try {
    await seedReferenceData();
    const row = await queryFirst<Overview>(
      `SELECT
        (SELECT COUNT(*) FROM agents) AS agents,
        (SELECT COUNT(*) FROM listings WHERE status = 'active') AS listings,
        (SELECT COUNT(*) FROM jobs WHERE state = 'COMPLETED') AS completedJobs,
        (SELECT CAST(COALESCE(SUM(CAST(price_apool AS REAL)), 0) AS TEXT)
           FROM jobs WHERE state = 'COMPLETED') AS volumeApool,
        (SELECT epoch FROM mining_epochs WHERE status = 'open' ORDER BY epoch DESC LIMIT 1) AS activeEpoch,
        (SELECT budget_apool FROM mining_epochs WHERE status = 'open' ORDER BY epoch DESC LIMIT 1) AS activeEpochBudget`,
    );
    return apiResponse({
      ...row,
      token: AGENTPOOL,
      environment: "public-testnet",
      notice: "Reference records are testnet fixtures, not live economic claims.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
