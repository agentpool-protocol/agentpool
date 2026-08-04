import {
  CipherSuite,
  HkdfSha256,
} from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function suite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return `0x${Buffer.from(digest).toString("hex")}`;
}

export async function generatePrivateChannelKeyPair() {
  const hpke = suite();
  const pair = await hpke.kem.generateKeyPair();
  return {
    publicKey: `x25519:${base64Url(
      new Uint8Array(await hpke.kem.serializePublicKey(pair.publicKey)),
    )}`,
    privateKey: `x25519-private:${base64Url(
      new Uint8Array(await hpke.kem.serializePrivateKey(pair.privateKey)),
    )}`,
  };
}

export async function sealPrivateJson(
  recipientPublicKey,
  value,
  context = "AgentPool private coordination v1",
) {
  if (!String(recipientPublicKey).startsWith("x25519:")) {
    throw new Error("PRIVATE_CHANNEL_PUBLIC_KEY_INVALID");
  }
  const hpke = suite();
  const publicKey = await hpke.kem.deserializePublicKey(
    fromBase64Url(String(recipientPublicKey).slice("x25519:".length)),
  );
  const sender = await hpke.createSenderContext({
    recipientPublicKey: publicKey,
  });
  const plaintext = encoder.encode(JSON.stringify(value));
  const aad = encoder.encode(context);
  const ciphertext = new Uint8Array(await sender.seal(plaintext, aad));
  return {
    schema: "agentpool.private-envelope/v1",
    suite: "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
    enc: base64Url(new Uint8Array(sender.enc)),
    aad: base64Url(aad),
    ciphertext: base64Url(ciphertext),
    ciphertextHash: await sha256Hex(ciphertext),
  };
}

export async function openPrivateJson(recipientPrivateKey, envelope) {
  if (!String(recipientPrivateKey).startsWith("x25519-private:")) {
    throw new Error("PRIVATE_CHANNEL_PRIVATE_KEY_INVALID");
  }
  if (
    envelope?.schema !== "agentpool.private-envelope/v1" ||
    envelope?.suite !==
      "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305"
  ) {
    throw new Error("PRIVATE_CHANNEL_ENVELOPE_INVALID");
  }
  const hpke = suite();
  const privateKey = await hpke.kem.deserializePrivateKey(
    fromBase64Url(
      String(recipientPrivateKey).slice("x25519-private:".length),
    ),
  );
  const ciphertext = fromBase64Url(envelope.ciphertext);
  if (
    (await sha256Hex(ciphertext)).toLowerCase() !==
    String(envelope.ciphertextHash).toLowerCase()
  ) {
    throw new Error("PRIVATE_CHANNEL_CIPHERTEXT_HASH_MISMATCH");
  }
  const recipient = await hpke.createRecipientContext({
    recipientKey: privateKey,
    enc: fromBase64Url(envelope.enc),
  });
  const plaintext = await recipient.open(
    ciphertext,
    fromBase64Url(envelope.aad),
  );
  return JSON.parse(decoder.decode(plaintext));
}

