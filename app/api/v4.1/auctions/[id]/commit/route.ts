import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  profileId: z.string().min(8).max(100),
  commitment: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    const opportunity = await queryFirst<{ state: string; deadline_at: number }>(
      "SELECT state, deadline_at FROM v41_opportunities WHERE id = ?",
      id,
    );
    if (!opportunity || opportunity.state !== "OPEN" || opportunity.deadline_at <= Date.now()) {
      throw new Error("INVALID_AUCTION_STATE");
    }
    const profile = await queryFirst<{ owner_address: string; expires_at: number }>(
      "SELECT owner_address, expires_at FROM v41_execution_profiles WHERE id = ?",
      input.profileId,
    );
    if (
      !profile ||
      profile.owner_address.toLowerCase() !== auth.address.toLowerCase() ||
      profile.expires_at <= Date.now()
    ) throw new Error("AUTH_PROFILE_OWNER");
    const bidId = requestId();
    await execute(
      `INSERT INTO v41_bids
        (id, opportunity_id, bidder_address, profile_id, commitment, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'COMMITTED', ?)`,
      bidId,
      id,
      auth.address,
      input.profileId,
      input.commitment,
      Date.now(),
    );
    return {
      body: {
        id: bidId,
        opportunityId: id,
        state: "COMMITTED",
        awardCreated: false,
      },
      status: 201,
    };
  });
}

