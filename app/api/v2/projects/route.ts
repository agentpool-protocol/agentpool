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
import {
  isTemporaryChainError,
  verifyProjectFunding,
} from "@/lib/chain";
import { validationReserveFor } from "@/lib/protocol";
import { getAddress, type Hex } from "viem";

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
                  chain_project_id, created_at, updated_at
           FROM projects WHERE state = ? ORDER BY created_at DESC LIMIT 100`,
          state,
        )
      : await queryAll(
          `SELECT id, buyer_agent_id, coordinator_agent_id, brief AS public_summary,
                  brief_hash, plan_root, max_worker_budget_apool, validation_reserve_apool,
                  min_agents, max_parallel, max_tasks, state, deadline_at, tx_hash,
                  chain_project_id, created_at, updated_at
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
    if (BigInt(input.maxWorkerBudgetApool) < BigInt(input.maxTasks) * 1_000n) {
      throw new Error("INVALID_PROJECT_BUDGET");
    }
    const buyer = await agentAuthorization(
      input.buyerAgentId,
      auth.address,
    );
    if (!buyer) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    const coordinator = await queryFirst<{ id: string; owner_address: string }>(
      "SELECT id, owner_address FROM agents WHERE id = ? AND status = 'active'",
      input.coordinatorAgentId,
    );
    if (!coordinator || input.coordinatorAgentId === input.buyerAgentId) {
      throw new Error("INVALID_PROJECT_COORDINATOR");
    }
    const validationReserve = validationReserveFor(
      input.maxWorkerBudgetApool,
      input.maxTasks,
    ).toString();
    let state = "CREATED";
    let chainEvidence:
      | { blockNumber: bigint; logIndex: number; onchainProjectId: bigint }
      | undefined;
    try {
      chainEvidence = await verifyProjectFunding({
        txHash: input.txHash as Hex,
        buyer: getAddress(auth.address),
        coordinator: getAddress(coordinator.owner_address),
        maxWorkerBudget: BigInt(input.maxWorkerBudgetApool),
        validationReserve: BigInt(validationReserve),
        minWorkers: input.minAgents,
        maxTasks: input.maxTasks,
        deadline: BigInt(Math.floor(input.deadlineAt / 1_000)),
        briefHash: input.briefHash as Hex,
      });
    } catch (error) {
      if (!isTemporaryChainError(error)) {
        return new Response(
          JSON.stringify({
            error: "INVALID_CHAIN_TRANSACTION",
            message:
              error instanceof Error
                ? error.message
                : "Project funding transaction is invalid",
          }),
          {
            status: 422,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      state = "PENDING_CHAIN";
    }
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO projects
        (id, buyer_agent_id, coordinator_agent_id, brief, brief_hash, max_worker_budget_apool,
         validation_reserve_apool, min_agents, max_parallel, max_tasks, state, deadline_at,
         tx_hash, chain_project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      state,
      input.deadlineAt,
      input.txHash,
      chainEvidence?.onchainProjectId.toString() ?? null,
      now,
      now,
    );
    if (chainEvidence) {
      await execute(
        `INSERT INTO protocol_events
          (id, type, entity_id, actor_address, payload_json, chain_id,
           block_number, log_index, tx_hash, created_at)
         VALUES (?, 'PROJECT_CREATED', ?, ?, ?, 84532, ?, ?, ?, ?)`,
        requestId(),
        id,
        auth.address,
        JSON.stringify({
          onchainProjectId: chainEvidence.onchainProjectId.toString(),
        }),
        Number(chainEvidence.blockNumber),
        chainEvidence.logIndex,
        input.txHash,
        now,
      );
      await execute(
        `INSERT INTO chain_cursors (chain_id, last_finalized_block, updated_at)
         VALUES (84532, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_finalized_block = MAX(last_finalized_block, excluded.last_finalized_block),
           updated_at = excluded.updated_at`,
        Number(chainEvidence.blockNumber),
        now,
      );
    }
    const responseBody = {
      id,
      state,
      onchainProjectId: chainEvidence?.onchainProjectId.toString() ?? null,
      maxWorkerBudgetApool: input.maxWorkerBudgetApool,
      validationReserveApool: validationReserve,
      workerPriceFeeBps: 0,
      validationPricing: "fixed-by-verifier",
      validationFeeApool: { deterministic: 10, sandbox: 30, dispute: 50 },
      validationSplitBps: { validators: 9000, burn: 0, security: 1000 },
      next:
        state === "CREATED"
          ? "The exact contract call and ProjectCreated event are confirmed. The coordinator can now propose the Merkle DAG root."
          : "RPC confirmation is pending; no project task may activate until the chain event is verified.",
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: state === "CREATED" ? 201 : 202,
    });
    return apiResponse(responseBody, state === "CREATED" ? 201 : 202);
  } catch (error) {
    return handleApiError(error);
  }
}
