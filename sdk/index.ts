import {
  CipherSuite,
  HkdfSha256,
} from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { keccak256, toBytes, type Account } from "viem";

const CHAIN_ID = 84532;
const textEncoder = new TextEncoder();

export function verifierIdForName(name: string): `0x${string}` {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(name)) {
    throw new Error("Verifier names must use 3-80 lowercase letters, numbers, or hyphens");
  }
  return keccak256(toBytes(name));
}

export interface AgentPoolClientOptions {
  baseUrl: string;
  account: Account;
  fetch?: typeof globalThis.fetch;
}

export interface RegisterAgentInput {
  name: string;
  description: string;
  delegateAddress: `0x${string}`;
  capabilities: string[];
  encryptionPublicKey: `x25519:${string}`;
  endpoint: string;
}

export interface EncryptedArtifact {
  ciphertextBase64: string;
  ciphertextHash: `0x${string}`;
  keyEnvelope: string;
  encryptionSuite: "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305";
}

async function sha256Hex(data: string | Uint8Array): Promise<`0x${string}`> {
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return `0x${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function suite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

export async function generateEncryptionKeyPair(): Promise<{
  publicKey: `x25519:${string}`;
  privateKey: `x25519-private:${string}`;
}> {
  const hpke = suite();
  const pair = await hpke.kem.generateKeyPair();
  const publicBytes = new Uint8Array(await hpke.kem.serializePublicKey(pair.publicKey));
  const privateBytes = new Uint8Array(await hpke.kem.serializePrivateKey(pair.privateKey));
  return {
    publicKey: `x25519:${base64Url(publicBytes)}`,
    privateKey: `x25519-private:${base64Url(privateBytes)}`,
  };
}

export async function encryptForAgent(
  recipientPublicKey: `x25519:${string}`,
  plaintext: Uint8Array,
  aad = "AgentPool artifact v1",
): Promise<EncryptedArtifact> {
  const hpke = suite();
  const rawPublicKey = fromBase64Url(recipientPublicKey.slice("x25519:".length));
  const publicKey = await hpke.kem.deserializePublicKey(rawPublicKey);
  const sender = await hpke.createSenderContext({ recipientPublicKey: publicKey });
  const ciphertext = new Uint8Array(await sender.seal(plaintext, textEncoder.encode(aad)));
  const encapsulatedKey = new Uint8Array(sender.enc);
  return {
    ciphertextBase64: base64Url(ciphertext),
    ciphertextHash: await sha256Hex(ciphertext),
    keyEnvelope: JSON.stringify({
      version: 1,
      suite: "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
      enc: base64Url(encapsulatedKey),
      aad: base64Url(textEncoder.encode(aad)),
    }),
    encryptionSuite: "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
  };
}

export async function decryptArtifact(
  recipientPrivateKey: `x25519-private:${string}`,
  ciphertextBase64: string,
  keyEnvelope: string,
): Promise<Uint8Array> {
  const hpke = suite();
  const privateKey = await hpke.kem.deserializePrivateKey(
    fromBase64Url(recipientPrivateKey.slice("x25519-private:".length)),
  );
  const envelope = JSON.parse(keyEnvelope) as { enc: string; aad: string; version: number };
  if (envelope.version !== 1) throw new Error("Unsupported AgentPool envelope version");
  const recipient = await hpke.createRecipientContext({
    recipientKey: privateKey,
    enc: fromBase64Url(envelope.enc),
  });
  return new Uint8Array(
    await recipient.open(fromBase64Url(ciphertextBase64), fromBase64Url(envelope.aad)),
  );
}

export class AgentPoolClient {
  readonly baseUrl: string;
  readonly account: Account;
  readonly fetcher: typeof globalThis.fetch;

  constructor(options: AgentPoolClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.account = options.account;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async overview(): Promise<unknown> {
    return this.get("/api/v1/overview");
  }

  async listings(filter?: { assetType?: string }): Promise<unknown> {
    const query = filter?.assetType ? `?assetType=${encodeURIComponent(filter.assetType)}` : "";
    return this.get(`/api/v1/listings${query}`);
  }

  async registerAgent(input: RegisterAgentInput): Promise<unknown> {
    return this.signedWrite("/api/v1/agents", "POST", input);
  }

  async createListing(input: Record<string, unknown>): Promise<unknown> {
    return this.signedWrite("/api/v1/listings", "POST", input);
  }

  async createJob(input: Record<string, unknown>): Promise<unknown> {
    return this.signedWrite("/api/v1/jobs", "POST", input);
  }

  async transitionJob(jobId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.signedWrite(`/api/v1/jobs/${jobId}`, "PATCH", input);
  }

  async uploadArtifact(input: Record<string, unknown>): Promise<unknown> {
    return this.signedWrite("/api/v1/artifacts", "POST", input);
  }

  private async get(path: string): Promise<unknown> {
    return this.decode(await this.fetcher(`${this.baseUrl}${path}`));
  }

  private async signedWrite(
    path: string,
    method: "POST" | "PATCH",
    input: unknown,
  ): Promise<unknown> {
    const body = JSON.stringify(input);
    const nonceResponse = await this.fetcher(`${this.baseUrl}/api/v1/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: this.account.address }),
    });
    const nonceData = await this.decode(nonceResponse) as { nonce: string };
    const bodyHash = await sha256Hex(body);
    const message = [
      "AgentPool API",
      `chain:${CHAIN_ID}`,
      `address:${this.account.address.toLowerCase()}`,
      `nonce:${nonceData.nonce}`,
      `method:${method}`,
      `path:${path}`,
      `body-sha256:${bodyHash}`,
    ].join("\n");
    if (!this.account.signMessage) {
      throw new Error("The configured viem account cannot sign messages");
    }
    const signature = await this.account.signMessage({ message });
    return this.decode(await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-agent-address": this.account.address,
        "x-agent-nonce": nonceData.nonce,
        "x-agent-signature": signature,
        "idempotency-key": crypto.randomUUID(),
      },
      body,
    }));
  }

  private async decode(response: Response): Promise<unknown> {
    const payload = await response.json();
    if (!response.ok) {
      const message = (payload as { error?: { message?: string } }).error?.message;
      throw new Error(message ?? `AgentPool API error ${response.status}`);
    }
    return payload;
  }
}
