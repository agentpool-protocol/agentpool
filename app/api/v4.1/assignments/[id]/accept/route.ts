import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  capacityOfferHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (_input, auth) => {
    const assignment = await queryFirst<{
      worker_address: string;
      state: string;
      deadline_at: number;
    }>(
      "SELECT worker_address, state, deadline_at FROM v41_assignments WHERE id = ?",
      id,
    );
    if (!assignment || assignment.worker_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_ASSIGNMENT_WORKER");
    }
    if (assignment.state !== "AWARDED" || assignment.deadline_at <= Date.now()) {
      throw new Error("INVALID_ASSIGNMENT_STATE");
    }
    await execute(
      "UPDATE v41_assignments SET state = 'ACCEPTED', updated_at = ? WHERE id = ? AND state = 'AWARDED'",
      Date.now(),
      id,
    );
    return { body: { id, state: "ACCEPTED", capacityReserved: true } };
  });
}

