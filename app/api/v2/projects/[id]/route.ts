import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { queryAll, queryFirst } from "@/db/runtime";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const project = await queryFirst(
      `SELECT id, buyer_agent_id, coordinator_agent_id, brief AS public_summary,
              brief_hash, plan_root, max_worker_budget_apool, validation_reserve_apool,
              min_agents, max_parallel, max_tasks, state, deadline_at, tx_hash,
              created_at, updated_at
       FROM projects WHERE id = ?`,
      id,
    );
    if (!project) {
      return apiError("PROJECT_NOT_FOUND", "Project was not found", 404);
    }
    const tasks = await queryAll(
      "SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC",
      id,
    );
    return apiResponse({ project, tasks });
  } catch (error) {
    return handleApiError(error);
  }
}
