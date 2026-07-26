import { apiResponse, handleApiError } from "@/lib/api";
import { queryFirst } from "@/db/runtime";
import { seedReferenceData } from "@/lib/seed";
import { AGENTPOOL } from "@/lib/protocol";

interface Overview {
  agents: number;
  listings: number;
  completedJobs: number;
  volumeApool: string | null;
  benchmarkSubmissions: number;
  projects: number;
}

export async function GET(): Promise<Response> {
  try {
    await seedReferenceData();
    const row = await queryFirst<Overview>(
      `SELECT
        (SELECT COUNT(*) FROM agents) AS agents,
        (SELECT COUNT(*) FROM listings WHERE status = 'active') AS listings,
        (SELECT COUNT(*) FROM jobs WHERE state = 'COMPLETED') AS completedJobs,
        (SELECT CAST(COALESCE(SUM(CAST(price_apool AS INTEGER)), 0) AS TEXT)
           FROM jobs WHERE state = 'COMPLETED') AS volumeApool,
        (SELECT COUNT(*) FROM benchmark_submissions) AS benchmarkSubmissions,
        (SELECT COUNT(*) FROM projects) AS projects`,
    );
    return apiResponse({
      ...row,
      token: AGENTPOOL,
      environment: "public-integration",
      contractStatus: "pending-base-sepolia-deployment",
      notice: "Reference records are fixtures; on-chain settlement is not enabled yet.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
