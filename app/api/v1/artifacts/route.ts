import { z } from "zod";
import { apiError, apiResponse, handleApiError } from "@/lib/api";
import {
  agentAuthorization,
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, getR2, queryFirst } from "@/db/runtime";

const MAX_CIPHERTEXT_BYTES = 5 * 1024 * 1024;

const artifactSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{2,199}$/),
  ownerAgentId: z.string().min(3).max(80),
  jobId: z.string().min(3).max(80).optional(),
  contentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  ciphertextHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  mediaType: z.string().min(3).max(120),
  keyEnvelope: z.string().min(16).max(8192),
  ciphertextBase64: z.string().min(4),
});

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const bodyText = await request.text();
    const auth = await authenticateAgentWrite(request, bodyText);
    const idempotencyKey = requireIdempotencyKey(request);
    const replay = await readIdempotentResponse(
      idempotencyKey,
      auth.address,
      auth.requestHash,
    );
    if (replay) return replay;
    const input = artifactSchema.parse(JSON.parse(bodyText));
    const owner = await agentAuthorization(
      input.ownerAgentId,
      auth.address,
    );
    if (!owner) {
      throw new Error("AUTH_NOT_AGENT_SIGNER");
    }
    if (input.jobId) {
      const job = await queryFirst<{ seller_agent_id: string }>(
        "SELECT seller_agent_id FROM jobs WHERE id = ?",
        input.jobId,
      );
      if (!job || job.seller_agent_id !== input.ownerAgentId) {
        return apiError(
          "ARTIFACT_JOB_MISMATCH",
          "Only the job's seller agent can attach its encrypted delivery",
          403,
        );
      }
    }
    const existing = await queryFirst<{ key: string }>(
      "SELECT key FROM artifacts WHERE key = ?",
      input.key,
    );
    if (existing) {
      return apiError("ARTIFACT_KEY_EXISTS", "Artifact keys are immutable", 409);
    }
    const ciphertext = decodeBase64(input.ciphertextBase64);
    if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
      return apiError("ARTIFACT_TOO_LARGE", "Inline artifact uploads are limited to 5 MiB", 413);
    }
    const computedDigest = await crypto.subtle.digest(
      "SHA-256",
      ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength,
      ) as ArrayBuffer,
    );
    const computedHash = `0x${Array.from(new Uint8Array(computedDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    if (computedHash.toLowerCase() !== input.ciphertextHash.toLowerCase()) {
      return apiError("CIPHERTEXT_HASH_MISMATCH", "ciphertextHash does not match the uploaded bytes", 422);
    }

    const stored = await getR2().put(input.key, ciphertext, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        ciphertextHash: computedHash,
        mediaType: input.mediaType,
        encryptionSuite: "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
      },
    });
    if (!stored) {
      return apiError("ARTIFACT_KEY_EXISTS", "Artifact keys are immutable", 409);
    }
    await execute(
      `INSERT INTO artifacts
        (key, owner_agent_id, job_id, content_hash, ciphertext_hash, media_type,
         size_bytes, encryption_suite, key_envelope, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?)`,
      input.key,
      input.ownerAgentId,
      input.jobId ?? null,
      input.contentHash,
      computedHash,
      input.mediaType,
      ciphertext.byteLength,
      "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
      input.keyEnvelope,
      Date.now(),
    );
    const responseBody = {
      key: input.key,
      ciphertextHash: computedHash,
      sizeBytes: ciphertext.byteLength,
      status: "sealed",
    };
    await storeIdempotentResponse({
      key: idempotencyKey,
      actorAddress: auth.address,
      requestHash: auth.requestHash,
      responseBody,
      statusCode: 201,
    });
    return apiResponse(responseBody, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
