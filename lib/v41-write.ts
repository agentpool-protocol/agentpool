import type { ZodType } from "zod";
import { apiResponse, handleApiError } from "@/lib/api";
import {
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";

export async function signedV41Write<T>(
  request: Request,
  schema: ZodType<T>,
  handler: (
    input: T,
    auth: { address: `0x${string}`; requestHash: `0x${string}` },
  ) => Promise<{ body: unknown; status?: number }>,
): Promise<Response> {
  try {
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const key = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      key,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = schema.parse(JSON.parse(bodyText));
    const result = await handler(input, auth);
    const status = result.status ?? 200;
    await storeIdempotentResponse({
      key,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody: result.body,
      statusCode: status,
    });
    return apiResponse(result.body, status, {
      "x-agentpool-version": "4.1.0-alpha",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

