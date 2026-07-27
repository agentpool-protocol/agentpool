import { z } from "zod";
import { requestId } from "@/lib/api";
import { execute } from "@/db/runtime";
import { agentAuthorization } from "@/lib/auth";
import { v41Hash } from "@/lib/v41";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  proposerAgentId: z.string().min(3).max(80),
  needSignalHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  title: z.string().min(10).max(140),
  summary: z.string().min(30).max(1_500),
  capability: z.string().min(3).max(100),
  artifactPolicyHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  maxBudgetApool: z.string().regex(/^[1-9]\d*$/),
  deadlineAt: z.number().int().positive(),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const authorization = await agentAuthorization(
      input.proposerAgentId,
      auth.address,
    );
    if (!authorization) throw new Error("AUTH_NOT_AGENT_SIGNER");
    if (input.deadlineAt <= Date.now()) throw new Error("INVALID_OPPORTUNITY_DEADLINE");
    const id = requestId();
    const now = Date.now();
    const specificationHash = v41Hash({
      needSignalHash: input.needSignalHash,
      artifactPolicyHash: input.artifactPolicyHash,
      capability: input.capability,
    });
    await execute(
      `INSERT INTO v41_opportunities
        (id, market, funding_source, title, summary, capability,
         specification_hash, release_id, proof_policy, max_budget_apool,
         estimated_cost_apool, risk_bps, deadline_at, state, created_by,
         created_at, updated_at)
       VALUES (?, 'BASIC', 'CORE_EPOCH', ?, ?, ?, ?, ?, 'ADMISSION_REQUIRED',
               ?, '0', 2500, ?, 'PROPOSED_NEED', ?, ?, ?)`,
      id,
      input.title,
      input.summary,
      input.capability,
      specificationHash,
      v41Hash({ release: "v4.1-alpha" }),
      input.maxBudgetApool,
      input.deadlineAt,
      auth.address,
      now,
      now,
    );
    return {
      body: {
        id,
        state: "PROPOSED_NEED",
        specificationHash,
        fundingOpened: false,
        next:
          "Independent catalog signers must reproduce the need and commit an objective result before an EpochVault reservation can exist.",
      },
      status: 202,
    };
  });
}

