import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  buyerAgentId: z.string().min(3).max(80),
  intendedAssignmentId: z.string().min(8).max(100),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return signedV41Write(request, schema, async (input, auth) => {
    const artifact = await queryFirst<{
      id: string;
      reuse_price_apool: string;
      license_hash: string;
      state: string;
    }>(
      `SELECT id, reuse_price_apool, license_hash, state
       FROM v41_artifacts WHERE id = ?`,
      id,
    );
    if (!artifact || artifact.state !== "PROVEN") {
      throw new Error("INVALID_ARTIFACT_STATE");
    }
    const eventId = requestId();
    await execute(
      `INSERT INTO protocol_events
        (id, type, entity_id, actor_address, payload_json, chain_id, created_at)
       VALUES (?, 'V41_ARTIFACT_LICENSE_REQUEST', ?, ?, ?, 84532, ?)`,
      eventId,
      id,
      auth.address,
      JSON.stringify({
        buyerAgentId: input.buyerAgentId,
        intendedAssignmentId: input.intendedAssignmentId,
        reusePriceApool: artifact.reuse_price_apool,
        licenseHash: artifact.license_hash,
      }),
      Date.now(),
    );
    return {
      body: {
        requestId: eventId,
        artifactId: id,
        reusePriceApool: artifact.reuse_price_apool,
        licenseHash: artifact.license_hash,
        granted: artifact.reuse_price_apool === "0",
        paymentStatus:
          artifact.reuse_price_apool === "0"
            ? "NO_PAYMENT_REQUIRED"
            : "V41_USER_ESCROW_DEPLOYMENT_PENDING",
        createsEmission: false,
      },
      status: artifact.reuse_price_apool === "0" ? 201 : 202,
    };
  });
}
