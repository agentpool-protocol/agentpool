import { isAddress, keccak256, toBytes, verifyMessage } from "viem";
import { execute, queryFirst } from "@/db/runtime";
import { AGENTPOOL } from "@/lib/protocol";

interface NonceRecord {
  address: string;
  nonce: string;
  expires_at: number;
  used_at: number | null;
}

export interface AuthenticatedAgent {
  address: `0x${string}`;
  requestHash: `0x${string}`;
}

export interface AgentAuthorization {
  ownerAddress: string;
  delegateAddress: string;
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/u.test(key)) {
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

export async function agentAuthorization(
  agentId: string,
  signerAddress: string,
): Promise<AgentAuthorization | null> {
  const agent = await queryFirst<{
    owner_address: string;
    delegate_address: string;
  }>(
    `SELECT owner_address, delegate_address FROM agents
     WHERE id = ? AND status = 'active'`,
    agentId,
  );
  if (!agent) return null;
  const signer = signerAddress.toLowerCase();
  if (
    agent.owner_address.toLowerCase() !== signer &&
    agent.delegate_address.toLowerCase() !== signer
  ) {
    return null;
  }
  return {
    ownerAddress: agent.owner_address.toLowerCase(),
    delegateAddress: agent.delegate_address.toLowerCase(),
  };
}

export function canonicalAgentMessage(input: {
  address: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    "AgentPool API",
    `chain:${AGENTPOOL.chain.id}`,
    `address:${input.address.toLowerCase()}`,
    `nonce:${input.nonce}`,
    `method:${input.method.toUpperCase()}`,
    `path:${input.path}`,
    `body-sha256:${input.bodyHash}`,
  ].join("\n");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export async function authenticateAgentWrite(
  request: Request,
  bodyText: string,
): Promise<AuthenticatedAgent> {
  const address = request.headers.get("x-agent-address")?.toLowerCase();
  const nonce = request.headers.get("x-agent-nonce");
  const signature = request.headers.get("x-agent-signature");
  if (!address || !nonce || !signature || !isAddress(address)) {
    throw new Error("AUTH_MISSING_SIGNATURE");
  }

  const record = await queryFirst<NonceRecord>(
    "SELECT address, nonce, expires_at, used_at FROM api_nonces WHERE address = ?",
    address,
  );
  if (!record || record.nonce !== nonce) {
    throw new Error("AUTH_NONCE_MISMATCH");
  }
  if (record.used_at !== null || record.expires_at <= Date.now()) {
    throw new Error("AUTH_NONCE_EXPIRED");
  }

  const url = new URL(request.url);
  const bodyHash = await sha256Hex(bodyText);
  const message = canonicalAgentMessage({
    address,
    nonce,
    method: request.method,
    path: url.pathname,
    bodyHash,
  });
  const valid = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });
  if (!valid) {
    throw new Error("AUTH_INVALID_SIGNATURE");
  }

  const consumed = await execute(
    "UPDATE api_nonces SET used_at = ? WHERE address = ? AND nonce = ? AND used_at IS NULL",
    Date.now(),
    address,
    nonce,
  );
  if (!consumed.success || consumed.meta.changes !== 1) {
    throw new Error("AUTH_NONCE_ALREADY_USED");
  }

  return {
    address: address as `0x${string}`,
    requestHash: keccak256(
      toBytes(`${request.method.toUpperCase()}\n${url.pathname}\n${bodyHash}`),
    ),
  };
}

export async function readIdempotentResponse(
  key: string | null,
  actorAddress: string,
  requestHash: string,
): Promise<Response | null> {
  if (!key) return null;
  const scopedKey = `${actorAddress.toLowerCase()}:${key}`;
  const record = await queryFirst<{
    request_hash: string;
    response_json: string;
    status_code: number;
    expires_at: number;
  }>(
    "SELECT request_hash, response_json, status_code, expires_at FROM idempotency_keys WHERE key = ?",
    scopedKey,
  );
  if (!record || record.expires_at <= Date.now()) return null;
  if (record.request_hash !== requestHash) {
    throw new Error("AUTH_IDEMPOTENCY_CONFLICT");
  }
  return new Response(record.response_json, {
    status: record.status_code,
    headers: { "content-type": "application/json", "x-idempotent-replay": "true" },
  });
}

export async function storeIdempotentResponse(input: {
  key: string | null;
  actorAddress: string;
  requestHash: string;
  responseBody: unknown;
  statusCode: number;
}): Promise<void> {
  if (!input.key) return;
  const now = Date.now();
  const scopedKey = `${input.actorAddress.toLowerCase()}:${input.key}`;
  await execute(
    `INSERT OR REPLACE INTO idempotency_keys
      (key, actor_address, request_hash, response_json, status_code, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    scopedKey,
    input.actorAddress,
    input.requestHash,
    JSON.stringify(input.responseBody),
    input.statusCode,
    now + 24 * 60 * 60 * 1000,
    now,
  );
}
