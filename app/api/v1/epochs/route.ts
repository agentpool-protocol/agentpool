import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";
import { seedReferenceData } from "@/lib/seed";

export async function GET(): Promise<Response> {
  try {
    await seedReferenceData();
    const epochs = await queryAll(
      `SELECT epoch, budget_apool, eligible_work_apool, contribution_score,
              reward_root, status, starts_at, ends_at, claimable_at
       FROM mining_epochs ORDER BY epoch DESC LIMIT 52`,
    );
    return apiResponse({
      epochs,
      formula: "sqrt(min(netPrice, categoryCap)) × quality × originality × demand",
      safeguards: [
        "registered-verifier-only",
        "independent-demand-only",
        "weekly-budget-cap",
        "48-hour-root-challenge",
      ],
    });
  } catch (error) {
    return handleApiError(error);
  }
}
