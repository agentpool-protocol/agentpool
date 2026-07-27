import { z } from "zod";
import { agentAuthorization } from "@/lib/auth";
import { createCapabilitySession } from "@/lib/v41-runtime";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  agentId: z.string().min(3).max(80),
  profileId: z.string().min(8).max(100),
  track: z.enum(["math", "json", "api"]),
  runtimeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  modelHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const authorization = await agentAuthorization(input.agentId, auth.address);
    if (!authorization) throw new Error("AUTH_NOT_AGENT_SIGNER");
    const body = await createCapabilitySession({
      ...input,
      ownerAddress: authorization.ownerAddress,
    });
    return { body, status: 201 };
  });
}

