import { z } from "zod";
import { getAddress, keccak256, parseUnits, type Hex } from "viem";
import { queryFirst } from "@/db/runtime";
import {
  buildV41SettleTransaction,
  validateV41SettlementTerms,
} from "@/lib/v41-chain-bridge";
import { V41_DEPLOYMENT } from "@/lib/v41-chain";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  proof: z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/),
  recipients: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1).max(32),
  amountsApool: z.array(z.string().regex(/^(?:0|[1-9]\d*)$/)).min(1).max(32),
  artifactContentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    if (input.recipients.length !== input.amountsApool.length) {
      throw new Error("INVALID_V41_PAYOUT_LENGTH");
    }
    const assignment = await queryFirst<{
      worker_address: string;
      state: string;
      reserved_apool: string;
      vault_address: string;
    }>(
      `SELECT a.worker_address, a.state, a.reserved_apool,
              c.vault_address
       FROM v41_assignments a
       JOIN v41_chain_assignments c ON c.assignment_id = a.id
       WHERE a.id = ?`,
      id,
    );
    if (!assignment || assignment.worker_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_ASSIGNMENT_WORKER");
    }
    if (!["DELIVERED", "PROOF_PENDING"].includes(assignment.state)) {
      throw new Error("INVALID_ASSIGNMENT_STATE");
    }
    const total = input.amountsApool.reduce(
      (sum, amount) =>
        sum + parseUnits(amount, V41_DEPLOYMENT.token.decimals),
      0n,
    );
    if (
      total !==
      parseUnits(assignment.reserved_apool, V41_DEPLOYMENT.token.decimals)
    ) {
      throw new Error("INVALID_V41_PAYOUT_TOTAL");
    }
    const vault = getAddress(assignment.vault_address);
    const recipients = input.recipients.map((address) => getAddress(address));
    await validateV41SettlementTerms({
      vault,
      assignmentId: id as Hex,
      recipients,
      amountsApool: input.amountsApool,
    });
    const transactionRequest = buildV41SettleTransaction({
      vault,
      assignmentId: id as Hex,
      proof: input.proof as Hex,
      recipients,
      amountsApool: input.amountsApool,
      artifactContentHash: input.artifactContentHash as Hex,
    });
    return {
      body: {
        id,
        state: "PENDING_CHAIN",
        requestedAction: "SETTLE",
        proofHash: keccak256(input.proof as Hex),
        transactionRequest,
        next:
          "Any keeper may submit this exact transaction. The worker then confirms its hash through /api/v4.1/chain/confirm.",
      },
    };
  });
}
