import { z } from "zod";
import { queryFirst } from "@/db/runtime";
import { getAddress, type Hex } from "viem";
import { buildV41AcceptTransaction } from "@/lib/v41-chain-bridge";
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
      vault_address: string;
    }>(
      `SELECT a.worker_address, a.state, a.deadline_at, c.vault_address
       FROM v41_assignments a
       JOIN v41_chain_assignments c ON c.assignment_id = a.id
       WHERE a.id = ?`,
      id,
    );
    if (!assignment || assignment.worker_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_ASSIGNMENT_WORKER");
    }
    if (assignment.state !== "AWARDED" || assignment.deadline_at <= Date.now()) {
      throw new Error("INVALID_ASSIGNMENT_STATE");
    }
    return {
      body: {
        id,
        state: "PENDING_CHAIN",
        requestedAction: "ACCEPT",
        transactionRequest: buildV41AcceptTransaction({
          vault: getAddress(assignment.vault_address),
          assignmentId: id as Hex,
        }),
        next:
          "Sign this Base Sepolia transaction locally, then submit its hash to /api/v4.1/chain/confirm.",
      },
    };
  });
}
