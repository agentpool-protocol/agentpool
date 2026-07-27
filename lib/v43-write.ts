import type { ZodType } from "zod";
import { apiResponse, handleApiError } from "@/lib/api";
import {
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";

const MAX_SIGNED_BODY_BYTES = 16_384;

export async function signedV43Write<T>(
  request: Request,
  schema: ZodType<T>,
  handler: (
    input: T,
    auth: { address: `0x${string}`; requestHash: `0x${string}` },
    envelope: { nonce: string; signature: string; bodyText: string },
  ) => Promise<{ body: unknown; status?: number }>,
): Promise<Response> {
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > MAX_SIGNED_BODY_BYTES) {
      throw new Error("V43_COORDINATION_BODY_TOO_LARGE");
    }
    const nonce = request.headers.get("x-agent-nonce") ?? "";
    const signature = request.headers.get("x-agent-signature") ?? "";
    const auth = await authenticateAgentWrite(request, bodyText);
    const key = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      key,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = schema.parse(JSON.parse(bodyText));
    const result = await handler(input, auth, {
      nonce,
      signature,
      bodyText,
    });
    const status = result.status ?? 200;
    await storeIdempotentResponse({
      key,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody: result.body,
      statusCode: status,
    });
    return apiResponse(result.body, status, {
      "x-agentpool-version": "4.3.4-bootstrap-alpha",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
