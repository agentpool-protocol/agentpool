import { z } from "zod";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryAll, queryFirst } from "@/db/runtime";
import { validationFeeFor, workerBondFor } from "@/lib/protocol";

const taskSchema = z.object({
  workerAgentId: z.string().min(3).max(80),
  title: z.string().min(3).max(160),
  strategy: z.enum(["single", "parallel", "ensemble", "pipeline"]),
  priceApool: z.string().regex(/^[1-9]\d*$/),
  dependencies: z.array(z.string().min(3).max(100)).max(31).default([]),
  requirementsHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  deadlineAt: z.number().int().positive(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const rows = await queryAll(
      "SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC",
      id,
    );
    return apiResponse({ tasks: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: projectId } = await context.params;
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = taskSchema.parse(JSON.parse(bodyText));
    const project = await queryFirst<{
      buyer_agent_id: string;
      coordinator_agent_id: string;
      max_worker_budget_apool: string;
      validation_reserve_apool: string;
      max_tasks: number;
      deadline_at: number;
      state: string;
    }>(
      "SELECT * FROM projects WHERE id = ?",
      projectId,
    );
    if (!project) {
      return apiError("PROJECT_NOT_FOUND", "Project was not found", 404);
    }
    const coordinator = await agentAuthorization(
      project.coordinator_agent_id,
      auth.address,
    );
    if (!coordinator) {
      throw new Error("AUTH_NOT_PROJECT_COORDINATOR");
    }
    if (!["PENDING_CHAIN", "FUNDED", "PLANNED", "ACTIVE"].includes(project.state)) {
      return apiError("PROJECT_NOT_PLANNABLE", "Project no longer accepts plan tasks", 409);
    }
    if (input.deadlineAt > project.deadline_at || input.deadlineAt <= Date.now()) {
      return apiError("INVALID_TASK_DEADLINE", "Task deadline must be within the project window", 422);
    }
    if (input.workerAgentId === project.buyer_agent_id) {
      return apiError("SELF_DEALING_REJECTED", "The buyer agent cannot also be a paid worker", 422);
    }
    const worker = await queryFirst<{ id: string }>(
      "SELECT id FROM agents WHERE id = ? AND status = 'active'",
      input.workerAgentId,
    );
    if (!worker) {
      return apiError("WORKER_UNAVAILABLE", "Worker agent is not active", 409);
    }
    const existing = await queryAll<{ id: string; price_apool: string; validation_fee_apool: string }>(
      "SELECT id, price_apool, validation_fee_apool FROM project_tasks WHERE project_id = ?",
      projectId,
    );
    if (existing.length >= project.max_tasks) {
      return apiError("TASK_LIMIT_REACHED", "Project task limit has been reached", 409);
    }
    const knownIds = new Set(existing.map((task) => task.id));
    if (input.dependencies.some((dependency) => !knownIds.has(dependency))) {
      return apiError("UNKNOWN_DEPENDENCY", "Every dependency must be an earlier task in this project", 422);
    }
    const validationFee = validationFeeFor(input.priceApool);
    const workerBond = workerBondFor(input.priceApool);
    const committedWorker = existing.reduce((sum, task) => sum + BigInt(task.price_apool), 0n);
    const committedFees = existing.reduce(
      (sum, task) => sum + BigInt(task.validation_fee_apool),
      0n,
    );
    if (committedWorker + BigInt(input.priceApool) > BigInt(project.max_worker_budget_apool)) {
      return apiError("WORKER_BUDGET_EXCEEDED", "Task would exceed the signed worker budget", 409);
    }
    if (committedFees + validationFee > BigInt(project.validation_reserve_apool)) {
      return apiError("VALIDATION_BUDGET_EXCEEDED", "Task would exceed the signed validation reserve", 409);
    }
    const taskId = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO project_tasks
        (id, project_id, worker_agent_id, title, strategy, price_apool, validation_fee_apool,
         dependencies_json, requirements_hash, state, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      taskId,
      projectId,
      input.workerAgentId,
      input.title,
      input.strategy,
      input.priceApool,
      validationFee.toString(),
      JSON.stringify(input.dependencies),
      input.requirementsHash,
      input.deadlineAt,
      now,
      now,
    );
    const responseBody = {
      id: taskId,
      projectId,
      state: "DRAFT",
      priceApool: input.priceApool,
      validationFeeApool: validationFee.toString(),
      workerBondApool: workerBond.toString(),
      next: "Commit this task and its earlier dependency IDs into the Merkle plan; after buyer approval, submit its proof with addTask.",
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 201,
    });
    return apiResponse(responseBody, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
