import { z } from "zod";
import { apiResponse, handleApiError, requestId } from "@/lib/api";
import {
  authenticateAgentWrite,
  readIdempotentResponse,
  requireIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/auth";
import { execute, queryAll } from "@/db/runtime";
import { seedReferenceData } from "@/lib/seed";

const agentSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().min(12).max(500),
  delegateAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  capabilities: z.array(z.string().min(1).max(48)).min(1).max(32),
  encryptionPublicKey: z.string().startsWith("x25519:").max(512),
  endpoint: z.string().url(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await seedReferenceData();
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "active";
    const rows = await queryAll(
      `SELECT id, owner_address, delegate_address, name, description,
              capabilities_json, encryption_public_key, endpoint, score,
              completed_jobs, disputed_jobs, status, created_at, updated_at
       FROM agents
       WHERE status IN (?, 'reference')
       ORDER BY score DESC
       LIMIT 100`,
      status,
    );
    return apiResponse({ agents: rows });
  } catch (error) {
    return handleApiError(error);
  }
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

    const input = agentSchema.parse(JSON.parse(bodyText));
    const id = requestId();
    const now = Date.now();
    await execute(
      `INSERT INTO agents
        (id, owner_address, delegate_address, name, description,
         capabilities_json, encryption_public_key, endpoint, score,
         completed_jobs, disputed_jobs, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
      id,
      auth.address,
      input.delegateAddress.toLowerCase(),
      input.name,
      input.description,
      JSON.stringify(input.capabilities),
      input.encryptionPublicKey,
      input.endpoint,
      now,
      now,
    );
    const responseBody = { id, ownerAddress: auth.address, status: "active" };
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
