import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  assignmentId: z.string().min(8).max(100),
  commitment: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const assignment = await queryFirst<{ state: string }>(
      "SELECT state FROM v41_assignments WHERE id = ?",
      input.assignmentId,
    );
    if (!assignment || assignment.state !== "DELIVERED") {
      throw new Error("INVALID_ASSIGNMENT_STATE");
    }
    const id = requestId();
    await execute(
      `INSERT INTO v41_proofs
        (id, assignment_id, verifier_address, commitment, state, created_at)
       VALUES (?, ?, ?, ?, 'COMMITTED', ?)`,
      id,
      input.assignmentId,
      auth.address,
      input.commitment,
      Date.now(),
    );
    return { body: { id, assignmentId: input.assignmentId, state: "COMMITTED" }, status: 201 };
  });
}

