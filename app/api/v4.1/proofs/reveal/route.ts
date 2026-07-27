import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { v41Hash } from "@/lib/v41";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  assignmentId: z.string().min(8).max(100),
  decision: z.enum(["PASS", "FAIL", "AMBIGUOUS"]),
  evidenceHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  salt: z.string().min(16).max(256),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const proof = await queryFirst<{ id: string; commitment: string; state: string }>(
      `SELECT id, commitment, state FROM v41_proofs
       WHERE assignment_id = ? AND verifier_address = ?`,
      input.assignmentId,
      auth.address,
    );
    if (!proof || proof.state !== "COMMITTED") throw new Error("INVALID_PROOF_STATE");
    const commitment = v41Hash({
      assignmentId: input.assignmentId,
      verifierAddress: auth.address.toLowerCase(),
      decision: input.decision,
      evidenceHash: input.evidenceHash,
      salt: input.salt,
    });
    if (commitment !== proof.commitment) throw new Error("INVALID_PROOF_COMMITMENT");
    await execute(
      `UPDATE v41_proofs
       SET decision = ?, evidence_hash = ?, salt_hash = ?,
           state = 'REVEALED', revealed_at = ?
       WHERE id = ? AND state = 'COMMITTED'`,
      input.decision,
      input.evidenceHash,
      v41Hash({ salt: input.salt }),
      Date.now(),
      proof.id,
    );
    return {
      body: {
        id: proof.id,
        assignmentId: input.assignmentId,
        state: "REVEALED",
        payoutAmountAcceptedFromVerifier: false,
      },
    };
  });
}

