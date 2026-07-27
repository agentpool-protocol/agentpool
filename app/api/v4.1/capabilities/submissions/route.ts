import { z } from "zod";
import { submitCapabilitySession } from "@/lib/v41-runtime";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  sessionId: z.string().min(8).max(100),
  answer: z.unknown(),
  latencyMs: z.number().int().min(1).max(20 * 60 * 1_000),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => ({
    body: await submitCapabilitySession({
      ...input,
      ownerAddress: auth.address,
    }),
  }));
}

