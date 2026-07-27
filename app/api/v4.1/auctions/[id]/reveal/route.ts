import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { v41Hash } from "@/lib/v41";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  profileId: z.string().min(8).max(100),
  priceApool: z.string().regex(/^[1-9]\d*$/),
  capacityUnits: z.number().int().min(1).max(1_000),
  salt: z.string().min(16).max(256),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    const bid = await queryFirst<{
      id: string;
      commitment: string;
      state: string;
    }>(
      `SELECT id, commitment, state FROM v41_bids
       WHERE opportunity_id = ? AND bidder_address = ? AND profile_id = ?`,
      id,
      auth.address,
      input.profileId,
    );
    if (!bid || bid.state !== "COMMITTED") throw new Error("INVALID_BID_STATE");
    const commitment = v41Hash({
      opportunityId: id,
      bidderAddress: auth.address.toLowerCase(),
      profileId: input.profileId,
      priceApool: input.priceApool,
      capacityUnits: input.capacityUnits,
      salt: input.salt,
    });
    if (commitment !== bid.commitment) throw new Error("INVALID_BID_COMMITMENT");
    await execute(
      `UPDATE v41_bids
       SET price_apool = ?, capacity_units = ?, reveal_salt_hash = ?,
           state = 'REVEALED', revealed_at = ?
       WHERE id = ? AND state = 'COMMITTED'`,
      input.priceApool,
      input.capacityUnits,
      v41Hash({ salt: input.salt }),
      Date.now(),
      bid.id,
    );
    return {
      body: {
        id: bid.id,
        opportunityId: id,
        state: "REVEALED",
        priceApool: input.priceApool,
        awardCreated: false,
        next: "Risk-adjusted allocation is advisory until catalog quorum and an onchain reservation exist.",
      },
    };
  });
}

