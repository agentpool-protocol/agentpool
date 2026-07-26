import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";

const BASE_URL =
  process.env.AGENTPOOL_BASE_URL ??
  "https://agentpool-protocol.asfu.chatgpt.site";
const RPC_URL =
  process.env.AGENTPOOL_RPC_URL ??
  "https://sepolia.base.org";
const WALLET_FILE = path.resolve(".agentpool-beta-wallet.json");
const STATE_FILE = path.resolve(".agentpool-beta-state.json");

function savePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function loadJson(file) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : null;
}

function betaWallet() {
  const explicit = process.env.AGENTPOOL_BETA_PRIVATE_KEY;
  const stored = loadJson(WALLET_FILE);
  const privateKey = explicit ?? stored?.privateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  if (!explicit && !stored) {
    savePrivateJson(WALLET_FILE, {
      warning: "BASE SEPOLIA TEST WALLET ONLY. NEVER SEND REAL ASSETS.",
      address: account.address,
      privateKey,
    });
    console.log(`Created a Base Sepolia test-only wallet: ${account.address}`);
    console.log(`Saved locally: ${WALLET_FILE}`);
  }
  return account;
}

function encryptionIdentity(state) {
  if (state?.encryptionPublicKey) return state;
  const pair = crypto.generateKeyPairSync("x25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const next = {
    ...state,
    encryptionPublicKey: `x25519:${publicDer.subarray(-32).toString("base64url")}`,
    encryptionPrivateKeyPkcs8: privateDer.toString("base64"),
  };
  savePrivateJson(STATE_FILE, next);
  return next;
}

async function decode(response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${response.status} ${payload?.error?.code ?? "UNKNOWN"}: ${payload?.error?.message ?? "AgentPool request failed"}`,
    );
  }
  return payload;
}

async function signedWrite(account, route, body) {
  const bodyText = JSON.stringify(body);
  const nonce = await decode(
    await fetch(`${BASE_URL}/api/v1/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    }),
  );
  const bodyHash = `0x${crypto
    .createHash("sha256")
    .update(bodyText)
    .digest("hex")}`;
  const message = [
    "AgentPool API",
    "chain:84532",
    `address:${account.address.toLowerCase()}`,
    `nonce:${nonce.nonce}`,
    "method:POST",
    `path:${route}`,
    `body-sha256:${bodyHash}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  return decode(
    await fetch(`${BASE_URL}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-address": account.address,
        "x-agent-nonce": nonce.nonce,
        "x-agent-signature": signature,
        "idempotency-key": crypto.randomUUID(),
      },
      body: bodyText,
    }),
  );
}

function solveMath(session) {
  const { left, right, offset } = session.task;
  if (![left, right, offset].every(Number.isInteger)) {
    throw new Error("Unexpected public math challenge shape");
  }
  return { result: left * right + offset };
}

const account = betaWallet();
let state = encryptionIdentity(loadJson(STATE_FILE) ?? {});
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});
const chainId = await publicClient.getChainId();
if (chainId !== 84532) {
  throw new Error(`Refusing chain ${chainId}; this reference agent is Base Sepolia only`);
}
const gasBalance = await publicClient.getBalance({ address: account.address });
if (gasBalance === 0n) {
  console.log("");
  console.log(`Fund ${account.address} with FREE Base Sepolia test ETH, then run this file again.`);
  console.log("Official faucet list: https://docs.base.org/base-chain/network-information/network-faucets");
  console.log("Never send mainnet ETH or real tokens to this test wallet.");
  process.exit(0);
}

const agents = await decode(
  await fetch(`${BASE_URL}/api/v1/agents?status=active`),
);
let agent = agents.agents.find(
  (candidate) =>
    candidate.id === state.agentId ||
    candidate.owner_address?.toLowerCase() === account.address.toLowerCase(),
);
if (!agent) {
  const registered = await signedWrite(account, "/api/v1/agents", {
    name: `Open Beta ${account.address.slice(2, 8)}`,
    description: "Independent AgentPool Base Sepolia open-beta reference miner.",
    delegateAddress: account.address,
    capabilities: ["math", "data", "api"],
    encryptionPublicKey: state.encryptionPublicKey,
    endpoint: BASE_URL,
  });
  state = { ...state, agentId: registered.id };
  savePrivateJson(STATE_FILE, state);
  agent = { id: registered.id };
}

const session = await signedWrite(account, "/api/v2/mining/sessions", {
  minerAgentId: agent.id,
  recipientAddress: account.address,
  track: "math",
});
const submission = await signedWrite(account, "/api/v2/mining/submissions", {
  sessionId: session.id,
  challengeId: session.challengeId,
  minerAgentId: agent.id,
  recipientAddress: account.address,
  answer: solveMath(session),
});
if (
  submission.status !== "verified" ||
  submission.validatorSignatures?.length !== 3
) {
  throw new Error("The hosted 3-of-5 validator quorum did not issue a claim");
}

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC_URL),
});
const txHash = await walletClient.sendTransaction({
  account,
  to: submission.claim.to,
  data: submission.claim.calldata,
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash: txHash,
  confirmations: 2,
});
if (receipt.status !== "success") {
  throw new Error("The Base Sepolia claim transaction reverted");
}
const confirmation = await signedWrite(
  account,
  `/api/v2/mining/claims/${txHash}`,
  {
    submissionId: submission.id,
    minerAgentId: agent.id,
  },
);

console.log("");
console.log(`OPEN BETA PASS: ${session.rewardApool} test APOOL`);
console.log(`Agent: ${agent.id}`);
console.log(`Gateway: ${confirmation.status}`);
console.log(`Receipt: https://sepolia.basescan.org/tx/${txHash}`);
