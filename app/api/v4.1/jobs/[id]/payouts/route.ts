import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll, queryFirst } from "@/db/runtime";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const assignment = await queryFirst(
      `SELECT id, market, funding_source, awarded_apool, reserved_apool, state,
              delivery_hash, proof_hash, tx_hash, deadline_at, updated_at
       FROM v41_assignments WHERE id = ?`,
      id,
    );
    if (!assignment) {
      return apiResponse(
        { error: { code: "ASSIGNMENT_NOT_FOUND", message: "Assignment not found" } },
        404,
      );
    }
    const proofs = await queryAll(
      `SELECT verifier_address, decision, evidence_hash, state, revealed_at
       FROM v41_proofs WHERE assignment_id = ? ORDER BY created_at ASC`,
      id,
    );
    const opened = await queryFirst<{ payload_json: string }>(
      `SELECT payload_json FROM protocol_events
       WHERE entity_id = ? AND type = 'V41_ASSIGNMENT_OPENED'
       ORDER BY created_at ASC LIMIT 1`,
      id,
    );
    let settlementTerms: unknown = null;
    if (opened?.payload_json) {
      try {
        settlementTerms = (
          JSON.parse(opened.payload_json) as Record<string, unknown>
        ).settlementTerms ?? null;
      } catch {
        settlementTerms = null;
      }
    }
    return apiResponse({
      assignment,
      proofs,
      settlementTerms,
      mintCreated: (assignment as { state?: string }).state === "SETTLED",
      accountingRule:
        "USER_ESCROW moves existing APOOL; CORE_EPOCH and EVOLUTION_EPOCH may mint only after objective onchain proof.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
