import { apiError, apiResponse, handleApiError } from "@/lib/api";
import {
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { getR2 } from "@/db/runtime";

export const dynamic = "force-dynamic";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_SCHEMA = "agentpool.candidate.patch/v1";

interface CandidateArtifactManifest {
  schema?: unknown;
  sourceSnapshotDigest?: unknown;
  patchDigest?: unknown;
  testPassed?: unknown;
  objectiveCanary?: { passed?: unknown };
  changes?: unknown[];
}

function artifactKey(digest: string): string {
  return `v43/candidate-artifacts/${digest.slice("sha256:".length)}.json`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function validateManifest(value: CandidateArtifactManifest): void {
  if (
    value.schema !== ARTIFACT_SCHEMA ||
    typeof value.sourceSnapshotDigest !== "string" ||
    !SHA256.test(value.sourceSnapshotDigest) ||
    typeof value.patchDigest !== "string" ||
    !SHA256.test(value.patchDigest) ||
    value.testPassed !== true ||
    value.objectiveCanary?.passed !== true ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    value.changes.length > 40
  ) {
    throw new Error("V43_CANDIDATE_ARTIFACT_MANIFEST_INVALID");
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const digest = new URL(request.url).searchParams.get("digest") ?? "";
    if (!SHA256.test(digest)) {
      return apiError(
        "V43_CANDIDATE_ARTIFACT_DIGEST_INVALID",
        "A sha256 candidate artifact digest is required",
        400,
      );
    }
    const object = await getR2().get(artifactKey(digest));
    if (!object) {
      return apiError(
        "V43_CANDIDATE_ARTIFACT_NOT_FOUND",
        "Candidate artifact was not found",
        404,
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(object.size),
        "cache-control": "public, max-age=31536000, immutable",
        "x-agentpool-artifact-digest": digest,
        "x-agentpool-artifact-author":
          object.customMetadata?.authorAddress ?? "",
        "x-agentpool-source-snapshot":
          object.customMetadata?.sourceSnapshotDigest ?? "",
        "x-agentpool-patch-digest":
          object.customMetadata?.patchDigest ?? "",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const artifactJson = await request.text();
    const artifactBytes = new TextEncoder().encode(artifactJson);
    if (
      artifactBytes.byteLength === 0 ||
      artifactBytes.byteLength > MAX_ARTIFACT_BYTES
    ) {
      return apiError(
        "V43_CANDIDATE_ARTIFACT_SIZE_INVALID",
        "Candidate artifacts must be between 1 byte and 5 MiB",
        413,
      );
    }
    const auth = await authenticateAgentWrite(request, artifactJson);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;

    let manifest: CandidateArtifactManifest;
    try {
      manifest = JSON.parse(artifactJson) as CandidateArtifactManifest;
    } catch {
      throw new Error("V43_CANDIDATE_ARTIFACT_JSON_INVALID");
    }
    validateManifest(manifest);
    const digest = await sha256(artifactBytes);
    const claimedDigest =
      request.headers.get("x-agentpool-artifact-digest") ?? "";
    if (claimedDigest !== digest) {
      throw new Error("V43_CANDIDATE_ARTIFACT_DIGEST_MISMATCH");
    }

    const stored = await getR2().put(
      artifactKey(digest),
      artifactBytes,
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          artifactDigest: digest,
          authorAddress: auth.address.toLowerCase(),
          sourceSnapshotDigest: String(manifest.sourceSnapshotDigest),
          patchDigest: String(manifest.patchDigest),
          schema: ARTIFACT_SCHEMA,
        },
      },
    );
    if (!stored) {
      const existing = await getR2().head(artifactKey(digest));
      if (existing?.customMetadata?.artifactDigest !== digest) {
        throw new Error("V43_CANDIDATE_ARTIFACT_IMMUTABLE_CONFLICT");
      }
    }

    const responseBody = {
      artifactDigest: digest,
      authorAddress: auth.address.toLowerCase(),
      sourceSnapshotDigest: manifest.sourceSnapshotDigest,
      patchDigest: manifest.patchDigest,
      sizeBytes: artifactBytes.byteLength,
      immutable: true,
      publicPath:
        `/api/v4.3/candidates/artifacts?digest=${encodeURIComponent(digest)}`,
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 201,
    });
    return apiResponse(responseBody, 201, {
      "x-agentpool-version": "4.3.5-staged-autonomy-alpha",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
