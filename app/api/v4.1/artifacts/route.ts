import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const capability = new URL(request.url).searchParams.get("capability");
    const artifacts = capability
      ? await queryAll(
          `SELECT * FROM v41_artifacts
           WHERE capability = ? AND state = 'PROVEN'
           ORDER BY created_at DESC LIMIT 100`,
          capability,
        )
      : await queryAll(
          `SELECT * FROM v41_artifacts
           WHERE state = 'PROVEN'
           ORDER BY created_at DESC LIMIT 100`,
        );
    return apiResponse({
      artifacts,
      mintFromDownloads: false,
      registryPolicy: "Only settled public-work and system-improvement proofs are indexed.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

