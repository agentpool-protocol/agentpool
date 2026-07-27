import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { getAddress, type Hex } from "viem";
import { buildV41DeliverTransaction } from "@/lib/v41-chain-bridge";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  deliveryHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    const assignment = await queryFirst<{
      worker_address: string;
      state: string;
      deadline_at: number;
      delivery_hash: string | null;
      vault_address: string;
    }>(
      `SELECT a.worker_address, a.state, a.deadline_at, a.delivery_hash,
              c.vault_address
       FROM v41_assignments a
       JOIN v41_chain_assignments c ON c.assignment_id = a.id
       WHERE a.id = ?`,
      id,
    );
    if (!assignment || assignment.worker_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_ASSIGNMENT_WORKER");
    }
    if (
      !["ACCEPTED", "RUNNING"].includes(assignment.state) ||
      assignment.deadline_at <= Date.now()
    ) throw new Error("INVALID_ASSIGNMENT_STATE");
    if (
      assignment.delivery_hash &&
      assignment.delivery_hash.toLowerCase() !== input.deliveryHash.toLowerCase()
    ) {
      throw new Error("INVALID_DELIVERY_HASH_CHANGE");
    }
    await execute(
      `UPDATE v41_assignments SET delivery_hash = ?, updated_at = ?
       WHERE id = ? AND state IN ('ACCEPTED','RUNNING')`,
      input.deliveryHash,
      Date.now(),
      id,
    );
    return {
      body: {
        id,
        state: "PENDING_CHAIN",
        requestedAction: "DELIVER",
        deliveryHash: input.deliveryHash,
        payoutTriggered: false,
        transactionRequest: buildV41DeliverTransaction({
          vault: getAddress(assignment.vault_address),
          assignmentId: id as Hex,
          deliveryHash: input.deliveryHash as Hex,
        }),
        next:
          "Sign this Base Sepolia transaction locally, then submit its hash to /api/v4.1/chain/confirm.",
      },
    };
  });
}
