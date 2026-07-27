import { getAddress, isAddress } from "viem";
import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";

interface AssignmentRow {
  id: string;
  opportunity_id: string;
  worker_address: string;
  market: string;
  funding_source: string;
  awarded_apool: string;
  reserved_apool: string;
  state: string;
  delivery_hash: string | null;
  proof_hash: string | null;
  deadline_at: number;
  vault_address: string;
  open_tx_hash: string;
  payload_json: string | null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const worker = new URL(request.url).searchParams.get("worker");
    if (!worker || !isAddress(worker)) {
      return apiResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "A valid worker address is required",
          },
        },
        400,
      );
    }
    const rows = await queryAll<AssignmentRow>(
      `SELECT a.id, a.opportunity_id, a.worker_address, a.market,
              a.funding_source, a.awarded_apool, a.reserved_apool,
              a.state, a.delivery_hash, a.proof_hash, a.deadline_at,
              c.vault_address, c.open_tx_hash, e.payload_json
       FROM v41_assignments a
       JOIN v41_chain_assignments c ON c.assignment_id = a.id
       LEFT JOIN protocol_events e
         ON e.entity_id = a.id AND e.type = 'V41_ASSIGNMENT_OPENED'
       WHERE LOWER(a.worker_address) = LOWER(?)
       ORDER BY a.updated_at DESC
       LIMIT 50`,
      getAddress(worker),
    );
    return apiResponse({
      worker: getAddress(worker),
      assignments: rows.map((row) => {
        let opened: Record<string, unknown> | null = null;
        if (row.payload_json) {
          try {
            opened = JSON.parse(row.payload_json) as Record<string, unknown>;
          } catch {
            opened = null;
          }
        }
        return {
          id: row.id,
          opportunityId: row.opportunity_id,
          workerAddress: getAddress(row.worker_address),
          market: row.market,
          fundingSource: row.funding_source,
          awardedApool: row.awarded_apool,
          reservedApool: row.reserved_apool,
          state: row.state,
          deliveryHash: row.delivery_hash,
          proofHash: row.proof_hash,
          deadlineAt: row.deadline_at,
          chainId: 84532,
          vault: getAddress(row.vault_address),
          openTransactionHash: row.open_tx_hash,
          settlementTerms: opened?.settlementTerms ?? null,
        };
      }),
      authority:
        "Read-only index of exact Base Sepolia receipts; chain state is authoritative.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
