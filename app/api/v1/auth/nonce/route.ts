import { isAddress } from "viem";
import { z } from "zod";
import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { execute } from "@/db/runtime";

const requestSchema = z.object({
  address: z.string().refine(isAddress, "A valid EVM address is required"),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { address } = requestSchema.parse(await request.json());
    const normalized = address.toLowerCase();
    const nonce = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000;
    await execute(
      `INSERT INTO api_nonces (address, nonce, expires_at, used_at, created_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(address) DO UPDATE SET
         nonce = excluded.nonce,
         expires_at = excluded.expires_at,
         used_at = NULL,
         created_at = excluded.created_at`,
      normalized,
      nonce,
      expiresAt,
      now,
    );
    return apiResponse({ address: normalized, nonce, expiresAt });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    }
    return handleApiError(error);
  }
}
