#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
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
const DATA_HOME = path.resolve(
  process.env.AGENTPOOL_MCP_HOME ??
    path.join(os.homedir(), ".agentpool-testnet"),
);
const WALLET_FILE = path.join(DATA_HOME, "wallet.json");
const STATE_FILE = path.join(DATA_HOME, "state.json");
const EXPECTED_CHAIN_ID = 84532;

function readJson(file) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : null;
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function storedAccount() {
  const stored = readJson(WALLET_FILE);
  return stored?.privateKey
    ? privateKeyToAccount(stored.privateKey)
    : null;
}

function createTestWallet() {
  const existing = storedAccount();
  if (existing) return { account: existing, created: false };
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writePrivateJson(WALLET_FILE, {
    warning:
      "BASE SEPOLIA TEST WALLET ONLY. NEVER SEND MAINNET ETH, REAL TOKENS, OR SEED PHRASES.",
    network: "Base Sepolia",
    chainId: EXPECTED_CHAIN_ID,
    address: account.address,
    privateKey,
  });
  return { account, created: true };
}

function loadState() {
  return readJson(STATE_FILE) ?? { sessions: {} };
}

function saveState(state) {
  writePrivateJson(STATE_FILE, state);
}

function encryptionIdentity(state) {
  if (state.encryptionPublicKey) return state;
  const pair = crypto.generateKeyPairSync("x25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const next = {
    ...state,
    encryptionPublicKey: `x25519:${publicDer.subarray(-32).toString("base64url")}`,
    encryptionPrivateKeyPkcs8: privateDer.toString("base64"),
    sessions: state.sessions ?? {},
  };
  saveState(next);
  return next;
}

async function decode(response, allowRejected = false) {
  const payload = await response.json();
  if (
    !response.ok &&
    !(allowRejected && payload?.status === "rejected")
  ) {
    throw new Error(
      `${response.status} ${payload?.error?.code ?? "UNKNOWN"}: ${
        payload?.error?.message ?? "AgentPool request failed"
      }`,
    );
  }
  return payload;
}

async function getJson(route) {
  return decode(
    await fetch(`${BASE_URL}${route}`, {
      headers: { accept: "application/json" },
    }),
  );
}

async function signedWrite(account, route, body, allowRejected = false) {
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
    `chain:${EXPECTED_CHAIN_ID}`,
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
    allowRejected,
  );
}

function chainClients(account) {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });
  const walletClient = account
    ? createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(RPC_URL),
      })
    : null;
  return { publicClient, walletClient };
}

async function requireBaseSepolia(account) {
  const { publicClient, walletClient } = chainClients(account);
  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `TESTNET_BOUNDARY: refusing chain ${chainId}; AgentPool MCP is locked to Base Sepolia ${EXPECTED_CHAIN_ID}`,
    );
  }
  return { publicClient, walletClient };
}

async function ensureRegisteredMiner(account) {
  let state = encryptionIdentity(loadState());
  if (state.agentId) return { state, agentId: state.agentId };

  const registered = await signedWrite(account, "/api/v1/agents", {
    name: `MCP Miner ${account.address.slice(2, 8)}`,
    description:
      "Independent AgentPool Base Sepolia miner connected through the local MCP signing bridge.",
    delegateAddress: account.address,
    capabilities: ["math", "data", "api", "mcp"],
    encryptionPublicKey: state.encryptionPublicKey,
    endpoint: `${BASE_URL}/api/mcp`,
  });
  state = { ...state, agentId: registered.id };
  saveState(state);
  return { state, agentId: registered.id };
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent:
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : { value },
    ...(isError ? { isError: true } : {}),
  };
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function createServer() {
  const server = new McpServer(
    { name: "agentpool-local", version: "0.4.0-testnet" },
    {
      instructions:
        "Base Sepolia only. Never request or import a seed phrase or production key. Ask the user before creating the local test wallet or submitting an onchain claim.",
    },
  );

  server.registerTool(
    "agentpool_protocol_status",
    {
      title: "AgentPool protocol status",
      description:
        "Read public testnet contracts, validation fees, and mining limits.",
      annotations: readOnly,
    },
    async () => textResult(await getJson("/api/v2/status")),
  );

  server.registerTool(
    "agentpool_list_mining_tracks",
    {
      title: "List AgentPool mining tracks",
      description:
        "Read the available deterministic tasks and reward rules.",
      annotations: readOnly,
    },
    async () => textResult(await getJson("/api/v2/mining/tracks")),
  );

  server.registerTool(
    "agentpool_wallet_status",
    {
      title: "AgentPool local test-wallet status",
      description:
        "Check whether this computer has an AgentPool Base Sepolia test wallet and, if present, its public address and free test-ETH balance.",
      annotations: readOnly,
    },
    async () => {
      const account = storedAccount();
      if (!account) {
        return textResult({
          exists: false,
          next:
            "Explain the test-only local key boundary, then ask the user before calling agentpool_create_test_wallet.",
          dataHome: DATA_HOME,
        });
      }
      const { publicClient } = await requireBaseSepolia(account);
      const balance = await publicClient.getBalance({ address: account.address });
      return textResult({
        exists: true,
        network: "Base Sepolia",
        chainId: EXPECTED_CHAIN_ID,
        address: account.address,
        testEth: formatEther(balance),
        fundedForClaim: balance > 0n,
        dataHome: DATA_HOME,
      });
    },
  );

  server.registerTool(
    "agentpool_create_test_wallet",
    {
      title: "Create AgentPool test-only wallet",
      description:
        "Create a fresh Base Sepolia-only wallet on this computer. It never imports an existing wallet or asks for a seed phrase.",
      inputSchema: z
        .object({
          confirmation: z.literal("CREATE BASE SEPOLIA TEST WALLET"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const { account, created } = createTestWallet();
      return textResult({
        created,
        network: "Base Sepolia",
        chainId: EXPECTED_CHAIN_ID,
        address: account.address,
        privateKeyLocation: WALLET_FILE,
        next:
          "Send only free Base Sepolia test ETH to this public address, then call agentpool_wallet_status.",
        faucet:
          "https://docs.base.org/base-chain/network-information/network-faucets",
        warning:
          "Never send mainnet ETH, real tokens, a seed phrase, or a production key.",
      });
    },
  );

  server.registerTool(
    "agentpool_start_mining",
    {
      title: "Start AgentPool benchmark mining",
      description:
        "Register this test wallet if needed and request one private deterministic challenge. The calling AI must solve the returned task itself.",
      inputSchema: z
        .object({
          track: z.enum(["data", "math", "api"]),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ track }) => {
      const account = storedAccount();
      if (!account) {
        return textResult(
          {
            error: "NO_TEST_WALLET",
            next: "Call agentpool_create_test_wallet only after user approval.",
          },
          true,
        );
      }
      const { publicClient } = await requireBaseSepolia(account);
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance === 0n) {
        return textResult(
          {
            error: "TEST_GAS_REQUIRED",
            address: account.address,
            faucet:
              "https://docs.base.org/base-chain/network-information/network-faucets",
            warning: "Use free Base Sepolia test ETH only.",
          },
          true,
        );
      }
      const { state, agentId } = await ensureRegisteredMiner(account);
      const session = await signedWrite(
        account,
        "/api/v2/mining/sessions",
        {
          minerAgentId: agentId,
          recipientAddress: account.address,
          track,
        },
      );
      const nextState = {
        ...state,
        sessions: {
          ...(state.sessions ?? {}),
          [session.id]: session,
        },
      };
      saveState(nextState);
      return textResult({
        sessionId: session.id,
        challengeId: session.challengeId,
        track: session.track,
        task: session.task,
        expiresAt: session.expiresAt,
        rewardApool: session.rewardApool,
        instruction:
          "Solve task exactly, then call agentpool_submit_mining_answer with this sessionId and a JSON answer.",
      });
    },
  );

  server.registerTool(
    "agentpool_submit_mining_answer",
    {
      title: "Submit and claim AgentPool mining answer",
      description:
        "Submit the AI's answer for deterministic 3-of-5 validation. If correct, execute the Base Sepolia claim transaction and verify the gateway receipt.",
      inputSchema: z
        .object({
          sessionId: z.string().min(3).max(100),
          answer: z.unknown(),
          confirmation: z.literal("SUBMIT AND CLAIM TEST APOOL"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, answer }) => {
      const account = storedAccount();
      if (!account) {
        return textResult({ error: "NO_TEST_WALLET" }, true);
      }
      const state = loadState();
      const session = state.sessions?.[sessionId];
      if (!session) {
        return textResult(
          {
            error: "UNKNOWN_LOCAL_SESSION",
            message:
              "Start the challenge with this local MCP bridge before submitting.",
          },
          true,
        );
      }
      const { publicClient, walletClient } = await requireBaseSepolia(account);
      const submission = await signedWrite(
        account,
        "/api/v2/mining/submissions",
        {
          sessionId,
          challengeId: session.challengeId,
          minerAgentId: state.agentId,
          recipientAddress: account.address,
          answer,
        },
        true,
      );
      if (submission.status === "rejected") {
        const next = { ...state, sessions: { ...state.sessions } };
        delete next.sessions[sessionId];
        saveState(next);
        return textResult(
          {
            status: "rejected",
            reason: submission.reason,
            rewardApool: "0",
          },
          true,
        );
      }
      if (
        submission.status !== "verified" ||
        submission.validatorSignatures?.length !== 3
      ) {
        return textResult(
          {
            error: "VALIDATOR_QUORUM_NOT_ISSUED",
            submission,
          },
          true,
        );
      }
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
          minerAgentId: state.agentId,
        },
      );
      const next = { ...state, sessions: { ...state.sessions } };
      delete next.sessions[sessionId];
      saveState(next);
      return textResult({
        status: "claimed",
        rewardApool: submission.rewardApool,
        agentId: state.agentId,
        recipient: account.address,
        validatorSignatures: submission.validatorSignatures.length,
        gateway: confirmation.status,
        transactionHash: txHash,
        receipt: `https://sepolia.basescan.org/tx/${txHash}`,
      });
    },
  );

  server.registerTool(
    "agentpool_portfolio",
    {
      title: "Read AgentPool portfolio",
      description:
        "Read test APOOL balances, jobs, licenses, and service credits for the local wallet or a supplied public address.",
      inputSchema: z
        .object({
          address: z
            .string()
            .regex(/^0x[a-fA-F0-9]{40}$/)
            .optional(),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ address }) => {
      const selected = address ?? storedAccount()?.address;
      if (!selected) {
        return textResult(
          {
            error: "ADDRESS_REQUIRED",
            message:
              "Supply a public address or create a test-only wallet first.",
          },
          true,
        );
      }
      return textResult(
        await getJson(`/api/v1/portfolio/${encodeURIComponent(selected)}`),
      );
    },
  );

  return server;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const server = createServer();
    await server.close();
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        name: "agentpool-local",
        version: "0.4.0-testnet",
        chainId: EXPECTED_CHAIN_ID,
        walletCreated: false,
      })}\n`,
    );
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(
    `AgentPool MCP failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
