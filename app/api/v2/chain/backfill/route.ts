import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { apiError, apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryFirst } from "@/db/runtime";
import {
  verifyJobFunding,
  verifyProjectFunding,
} from "@/lib/chain";
import {
  validationFeeFor,
  validationReserveFor,
  verifierIdForName,
} from "@/lib/protocol";

const schema = z.object({
  entityType: z.enum(["job", "project"]),
  entityId: z.string().min(3).max(100),
});

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
    const input = schema.parse(JSON.parse(bodyText));
    const now = Date.now();
    let responseBody: Record<string, unknown>;

    if (input.entityType === "job") {
      const job = await queryFirst<{
        id: string;
        buyer_agent_id: string;
        seller_agent_id: string;
        price_apool: string;
        evaluation_budget_apool: string;
        seller_bond_apool: string;
        requirements_hash: string;
        verifier_id: string;
        deadline_at: number;
        tx_hash: string;
        state: string;
        seller_address: string;
      }>(
        `SELECT j.*, a.owner_address AS seller_address
         FROM jobs j
         JOIN agents a ON a.id = j.seller_agent_id
         WHERE j.id = ?`,
        input.entityId,
      );
      if (!job) return apiError("NOT_FOUND", "Job not found", 404);
      if (!(await agentAuthorization(job.buyer_agent_id, auth.address))) {
        return apiError("FORBIDDEN", "Only the buyer agent can backfill this job", 403);
      }
      if (job.state !== "PENDING_CHAIN") {
        return apiError("NOT_PENDING", "The job is not awaiting chain confirmation", 409);
      }
      const evidence = await verifyJobFunding({
        txHash: job.tx_hash as Hex,
        buyer: getAddress(auth.address),
        seller: getAddress(job.seller_address),
        price: BigInt(job.price_apool),
        sellerBond: BigInt(job.seller_bond_apool),
        deadline: BigInt(Math.floor(job.deadline_at / 1_000)),
        requirementsHash: job.requirements_hash as Hex,
        verifierId: verifierIdForName(job.verifier_id),
        validationFee: BigInt(
          job.evaluation_budget_apool || validationFeeFor(job.verifier_id),
        ),
      });
      await execute(
        "UPDATE jobs SET state = 'FUNDED', chain_job_id = ?, updated_at = ? WHERE id = ? AND state = 'PENDING_CHAIN'",
        evidence.onchainJobId.toString(),
        now,
        job.id,
      );
      await recordEvent({
        type: "JOB_FUNDED_BACKFILL",
        entityId: job.id,
        actor: auth.address,
        txHash: job.tx_hash,
        blockNumber: evidence.blockNumber,
        logIndex: evidence.logIndex,
        payload: { onchainJobId: evidence.onchainJobId.toString() },
        now,
      });
      responseBody = {
        entityType: "job",
        entityId: job.id,
        state: "FUNDED",
        onchainJobId: evidence.onchainJobId.toString(),
        blockNumber: evidence.blockNumber.toString(),
      };
    } else {
      const project = await queryFirst<{
        id: string;
        buyer_agent_id: string;
        coordinator_agent_id: string;
        brief_hash: string;
        max_worker_budget_apool: string;
        validation_reserve_apool: string;
        min_agents: number;
        max_tasks: number;
        deadline_at: number;
        tx_hash: string;
        state: string;
        coordinator_address: string;
      }>(
        `SELECT p.*, a.owner_address AS coordinator_address
         FROM projects p
         JOIN agents a ON a.id = p.coordinator_agent_id
         WHERE p.id = ?`,
        input.entityId,
      );
      if (!project) return apiError("NOT_FOUND", "Project not found", 404);
      if (!(await agentAuthorization(project.buyer_agent_id, auth.address))) {
        return apiError(
          "FORBIDDEN",
          "Only the buyer agent can backfill this project",
          403,
        );
      }
      if (project.state !== "PENDING_CHAIN") {
        return apiError(
          "NOT_PENDING",
          "The project is not awaiting chain confirmation",
          409,
        );
      }
      const expectedReserve = validationReserveFor(
        project.max_worker_budget_apool,
        project.max_tasks,
      );
      const evidence = await verifyProjectFunding({
        txHash: project.tx_hash as Hex,
        buyer: getAddress(auth.address),
        coordinator: getAddress(project.coordinator_address),
        maxWorkerBudget: BigInt(project.max_worker_budget_apool),
        validationReserve: expectedReserve,
        minWorkers: project.min_agents,
        maxTasks: project.max_tasks,
        deadline: BigInt(Math.floor(project.deadline_at / 1_000)),
        briefHash: project.brief_hash as Hex,
      });
      await execute(
        "UPDATE projects SET state = 'CREATED', chain_project_id = ?, updated_at = ? WHERE id = ? AND state = 'PENDING_CHAIN'",
        evidence.onchainProjectId.toString(),
        now,
        project.id,
      );
      await recordEvent({
        type: "PROJECT_CREATED_BACKFILL",
        entityId: project.id,
        actor: auth.address,
        txHash: project.tx_hash,
        blockNumber: evidence.blockNumber,
        logIndex: evidence.logIndex,
        payload: { onchainProjectId: evidence.onchainProjectId.toString() },
        now,
      });
      responseBody = {
        entityType: "project",
        entityId: project.id,
        state: "CREATED",
        onchainProjectId: evidence.onchainProjectId.toString(),
        blockNumber: evidence.blockNumber.toString(),
      };
    }

    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 200,
    });
    return apiResponse(responseBody);
  } catch (error) {
    return handleApiError(error);
  }
}

async function recordEvent(input: {
  type: string;
  entityId: string;
  actor: string;
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
  payload: Record<string, string>;
  now: number;
}) {
  await execute(
    `INSERT INTO protocol_events
      (id, type, entity_id, actor_address, payload_json, chain_id,
       block_number, log_index, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 84532, ?, ?, ?, ?)`,
    requestId(),
    input.type,
    input.entityId,
    input.actor,
    JSON.stringify(input.payload),
    Number(input.blockNumber),
    input.logIndex,
    input.txHash,
    input.now,
  );
  await execute(
    `INSERT INTO chain_cursors (chain_id, last_finalized_block, updated_at)
     VALUES (84532, ?, ?)
     ON CONFLICT(chain_id) DO UPDATE SET
       last_finalized_block = MAX(last_finalized_block, excluded.last_finalized_block),
       updated_at = excluded.updated_at`,
    Number(input.blockNumber),
    input.now,
  );
}
