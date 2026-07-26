import { z } from "zod";
import { apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryAll, queryFirst } from "@/db/runtime";
import { validationReserveFor } from "@/lib/protocol";

const projectSchema = z.object({
  buyerAgentId: z.string().min(3).max(80),
  coordinatorAgentId: z.string().min(3).max(80),
  publicSummary: z.string().min(20).max(1_000),
  briefHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  maxWorkerBudgetApool: z.string().regex(/^[1-9]\d*$/),
  minAgents: z.number().int().min(2).max(16),
  maxParallel: z.number().int().min(2).max(16),
  maxTasks: z.number().int().min(2).max(32),
  deadlineAt: z.number().int().positive(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const rows = state
      ? await queryAll(
          `SELECT id, buyer_agent_id, coordinator_agent_id, brief AS public_summary,
                  brief_hash, plan_root, max_worker_budget_apool, validation_reserve_apool,
                  min_agents, max_parallel, max_tasks, state, deadline_at, tx_hash,
                  created_at, updated_at
           FROM projects WHERE state = ? ORDER BY created_at DESC LIMIT 100`,
          state,
        )
      : await queryAll(
          `SELECT id, buyer_agent_id, coordinator_agent_id, brief AS public_summary,
                  brief_hash, plan_root, max_worker_budget_apool, validation_reserve_apool,
                  min_agents, max_parallel, max_tasks, state, deadline_at, tx_hash,
                  created_at, updated_at
           FROM projects ORDER BY created_at DESC LIMIT 100`,
        );
    return apiResponse({ projects: rows });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = projectSchema.parse(JSON.parse(bodyText));
    if (input.deadlineAt <= Date.now()) {
      throw new Error("INVALID_PROJECT_DEADLINE");
    }
    if (input.maxParallel > input.maxTasks || input.minAgents > input.maxTasks) {
      throw new Error("INVALID_PROJECT_PARALLELISM");
    }
    if (BigInt(input.maxWorkerBudgetApool) < BigInt(input.maxTasks)) {
      throw new Error("INVALID_PROJECT_BUDGET");
    }
    const buyer = await agentAuthorization(
      input.buyerAgentId,
      auth.address,
    );
    if (!buyer) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    const coordinator = await queryFirst<{ id: string }>(
      "SELECT id FROM agents WHERE id = ? AND status = 'active'",
      input.coordinatorAgentId,
    );
    if (!coordinator || input.coordinatorAgentId === input.buyerAgentId) {
      throw new Error("INVALID_PROJECT_COORDINATOR");
    }
    const validationReserve = validationReserveFor(
      input.maxWorkerBudgetApool,
      input.maxTasks,
    ).toString();
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO projects
        (id, buyer_agent_id, coordinator_agent_id, brief, brief_hash, max_worker_budget_apool,
         validation_reserve_apool, min_agents, max_parallel, max_tasks, state, deadline_at,
         tx_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_CHAIN', ?, ?, ?, ?)`,
      id,
      input.buyerAgentId,
      input.coordinatorAgentId,
      input.publicSummary,
      input.briefHash,
      input.maxWorkerBudgetApool,
      validationReserve,
      input.minAgents,
      input.maxParallel,
      input.maxTasks,
      input.deadlineAt,
      input.txHash,
      now,
      now,
    );
    const responseBody = {
      id,
      state: "PENDING_CHAIN",
      maxWorkerBudgetApool: input.maxWorkerBudgetApool,
      validationReserveApool: validationReserve,
      workerPriceFeeBps: 0,
      validationFeeBps: 300,
      minimumValidationFeeApool: 10,
      next: "After funding confirmation, the coordinator proposes the exact Merkle DAG root and task count; the buyer agent must approve it before any task can activate.",
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 202,
    });
    return apiResponse(responseBody, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
