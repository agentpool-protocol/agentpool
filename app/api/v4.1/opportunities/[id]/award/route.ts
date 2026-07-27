import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { executeBatch, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import { v41Hash } from "@/lib/v41";
import {
  validateV41AwardSettlementCommitment,
  verifyV41Award,
  v41VaultForMarket,
} from "@/lib/v41-chain-bridge";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  bidId: z.string().min(8).max(100),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  settlementTerms: z
    .object({
      deliveryHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      proof: z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/),
      recipients: z
        .array(z.string().regex(/^0x[a-fA-F0-9]{40}$/))
        .min(1)
        .max(32),
      amountsApool: z
        .array(z.string().regex(/^(?:0|[1-9]\d*)$/))
        .min(1)
        .max(32),
      artifactContentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      task: z.unknown(),
    })
    .optional(),
});

interface Opportunity {
  id: string;
  market: string;
  funding_source: string;
  specification_hash: Hex;
  release_id: string;
  proof_policy: string;
  max_budget_apool: string;
  deadline_at: number;
  state: string;
  created_by: string;
}

interface Bid {
  id: string;
  bidder_address: string;
  profile_id: string;
  price_apool: string;
  state: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    const [opportunity, bid] = await Promise.all([
      queryFirst<Opportunity>(
        `SELECT id, market, funding_source, specification_hash, release_id,
                proof_policy, max_budget_apool, deadline_at, state, created_by
         FROM v41_opportunities WHERE id = ?`,
        id,
      ),
      queryFirst<Bid>(
        `SELECT id, bidder_address, profile_id, price_apool, state
         FROM v41_bids WHERE id = ? AND opportunity_id = ?`,
        input.bidId,
        id,
      ),
    ]);
    if (!opportunity || !bid || bid.state !== "REVEALED" || !bid.price_apool) {
      throw new Error("INVALID_V41_AWARD_CANDIDATE");
    }
    if (!["OPEN", "SOFT_HELD"].includes(opportunity.state)) {
      throw new Error("INVALID_V41_AWARD_STATE");
    }
    if (opportunity.funding_source !== "CORE_EPOCH") {
      throw new Error("INVALID_V41_AWARD_FUNDING_SOURCE");
    }
    const vault = v41VaultForMarket(opportunity.market);
    const evidence = await verifyV41Award({
      txHash: input.txHash as Hex,
      vault,
      worker: getAddress(bid.bidder_address),
      specificationHash: opportunity.specification_hash,
      maxBudgetApool: opportunity.max_budget_apool,
      maxDeadlineAt: opportunity.deadline_at,
    });
    const settlementTerms = input.settlementTerms
      ? validateV41AwardSettlementCommitment({
          evidence,
          deliveryHash: input.settlementTerms.deliveryHash as Hex,
          proof: input.settlementTerms.proof as Hex,
          recipients: input.settlementTerms.recipients.map((address) =>
            getAddress(address),
          ),
          amountsApool: input.settlementTerms.amountsApool,
          artifactContentHash:
            input.settlementTerms.artifactContentHash as Hex,
        })
      : null;
    if (input.settlementTerms) {
      const taskJson = JSON.stringify(input.settlementTerms.task);
      if (!taskJson || taskJson.length > 16_384) {
        throw new Error("INVALID_V41_PILOT_TASK_SIZE");
      }
    }
    const existing = await queryFirst<{
      assignment_id: string;
      open_tx_hash: string;
    }>(
      `SELECT assignment_id, open_tx_hash FROM v41_chain_assignments
       WHERE assignment_id = ? OR open_tx_hash = ?`,
      evidence.assignmentId,
      input.txHash,
    );
    if (existing) {
      if (existing.open_tx_hash.toLowerCase() !== input.txHash.toLowerCase()) {
        throw new Error("INVALID_V41_AWARD_REPLAY");
      }
      return {
        body: {
          assignmentId: existing.assignment_id,
          state: "AWARDED",
          onchain: true,
          transactionHash: input.txHash,
          replayed: true,
        },
      };
    }
    const now = Date.now();
    const policyHash = v41Hash({
      proofPolicy: opportunity.proof_policy,
      expectedEvidenceHash: evidence.expectedEvidenceHash,
      payoutRoot: evidence.payoutRoot,
    });
    const eventId = requestId();
    await executeBatch([
      {
        sql: `INSERT INTO v41_assignments
          (id, opportunity_id, worker_address, profile_id, market,
           funding_source, release_id, policy_hash, awarded_apool,
           reserved_apool, state, tx_hash, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWARDED', ?, ?, ?, ?)`,
        bindings: [
          evidence.assignmentId,
          opportunity.id,
          evidence.worker,
          bid.profile_id,
          opportunity.market,
          opportunity.funding_source,
          opportunity.release_id,
          policyHash,
          bid.price_apool,
          evidence.reservedPayoutApool,
          input.txHash,
          Number(evidence.deadline) * 1_000,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO v41_chain_assignments
          (assignment_id, chain_id, vault_address, open_tx_hash,
           last_block, state, updated_at)
         VALUES (?, 84532, ?, ?, ?, 'AWARDED', ?)`,
        bindings: [
          evidence.assignmentId,
          vault,
          input.txHash,
          Number(evidence.blockNumber),
          now,
        ],
      },
      {
        sql: `UPDATE v41_bids SET state = 'SELECTED'
              WHERE id = ? AND state = 'REVEALED'`,
        bindings: [bid.id],
      },
      {
        sql: `UPDATE v41_opportunities SET state = 'AWARDED', updated_at = ?
              WHERE id = ? AND state IN ('OPEN','SOFT_HELD')`,
        bindings: [now, opportunity.id],
      },
      {
        sql: `INSERT INTO protocol_events
          (id, type, entity_id, actor_address, payload_json, chain_id,
           block_number, log_index, tx_hash, created_at)
         VALUES (?, 'V41_ASSIGNMENT_OPENED', ?, ?, ?, 84532, ?, ?, ?, ?)`,
        bindings: [
          eventId,
          evidence.assignmentId,
          evidence.worker,
          JSON.stringify({
            opportunityId: opportunity.id,
            vault,
            reservedPayoutApool: evidence.reservedPayoutApool,
            indexedBy: auth.address,
            ...(settlementTerms
              ? {
                  settlementTerms: {
                    ...settlementTerms,
                    task: input.settlementTerms?.task,
                  },
                }
              : {}),
          }),
          Number(evidence.blockNumber),
          evidence.logIndex,
          input.txHash,
          now,
        ],
      },
      {
        sql: `INSERT INTO chain_cursors
          (chain_id, last_finalized_block, updated_at)
         VALUES (84532, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_finalized_block =
             MAX(last_finalized_block, excluded.last_finalized_block),
           updated_at = excluded.updated_at`,
        bindings: [Number(evidence.blockNumber), now],
      },
    ]);
    return {
      body: {
        assignmentId: evidence.assignmentId,
        opportunityId: opportunity.id,
        state: "AWARDED",
        onchain: true,
        chainId: 84532,
        vault,
        reservedPayoutApool: evidence.reservedPayoutApool,
        transactionHash: input.txHash,
        blockNumber: evidence.blockNumber.toString(),
        settlementTermsPublished: settlementTerms !== null,
      },
      status: 201,
    };
  });
}
