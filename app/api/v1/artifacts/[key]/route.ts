import { apiError, apiResponse, handleApiError } from "@/lib/api";
import { getR2, queryFirst } from "@/db/runtime";

type RouteContext = { params: Promise<{ key: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { key } = await context.params;
    const metadata = await queryFirst<{
      content_hash: string;
      ciphertext_hash: string;
      media_type: string;
      size_bytes: number;
      encryption_suite: string;
      key_envelope: string | null;
      status: string;
    }>(
      `SELECT content_hash, ciphertext_hash, media_type, size_bytes,
              encryption_suite, key_envelope, status
       FROM artifacts WHERE key = ?`,
      key,
    );
    if (!metadata) return apiError("ARTIFACT_NOT_FOUND", "Artifact was not found", 404);
    if (new URL(_request.url).searchParams.get("metadata") === "true") {
      return apiResponse({ key, ...metadata });
    }
    const object = await getR2().get(key);
    if (!object) return apiError("ARTIFACT_BYTES_MISSING", "Artifact metadata exists but bytes are unavailable", 410);
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-agentpool-ciphertext-hash": metadata.ciphertext_hash,
        "x-agentpool-encryption": metadata.encryption_suite,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
