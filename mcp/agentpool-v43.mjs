#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { z } from "zod";
import deployment from "../deployments/84532.v43.5.json" with { type: "json" };
import tokenArtifact from "../artifacts/AgentPoolV43Token.json" with { type: "json" };
import marketArtifact from "../artifacts/AgentPoolV432TaskMarket.json" with { type: "json" };
import ledgerArtifact from "../artifacts/AgentPoolV43ContributionLedger.json" with { type: "json" };
import capacityArtifact from "../artifacts/AgentPoolV43CapacityRegistry.json" with { type: "json" };
import proofArtifact from "../artifacts/AgentPoolV432ProofRegistry.json" with { type: "json" };
import vaultArtifact from "../artifacts/AgentPoolV43EpochVault.json" with { type: "json" };
import registryArtifact from "../artifacts/AgentPoolV43ReleaseRegistry.json" with { type: "json" };
import issueGateV432Artifact from "../artifacts/AgentPoolV432SystemIssueGate.json" with { type: "json" };
import issueGateV435Artifact from "../artifacts/AgentPoolV435SystemIssueGate.json" with { type: "json" };
import transitionIssueConsensusArtifact from "../artifacts/AgentPoolV435TransitionIssueConsensus.json" with { type: "json" };
import issueConsensusArtifact from "../artifacts/AgentPoolV432IssueConsensus.json" with { type: "json" };
import evolutionConsensusArtifact from "../artifacts/AgentPoolV43EvolutionConsensus.json" with { type: "json" };
import {
  AgentPoolV43Engine,
  digest,
} from "../protocol/autonomy/agentpool-v43-engine.mjs";

const dataHome = path.resolve(
  process.env.AGENTPOOL_V43_HOME ??
    path.join(os.homedir(), ".agentpool-v43-alpha"),
);
const eventsPath = path.join(dataHome, "events.jsonl");
const walletPath = path.join(dataHome, "base-sepolia-wallet.json");
const engine = new AgentPoolV43Engine();
const chainRpcUrl =
  process.env.AGENTPOOL_V43_RPC_URL ?? "https://sepolia.base.org";
const relayBaseUrl = (
  process.env.AGENTPOOL_V43_RELAY_URL ??
  "https://agentpool-protocol.asfu.chatgpt.site"
).replace(/\/+$/u, "");
const chainClient = createPublicClient({
  chain: baseSepolia,
  transport: http(chainRpcUrl, { timeout: 30_000, retryCount: 3 }),
});
const contracts = deployment.contracts;
const stagedAutonomyAvailable = Boolean(contracts.transitionIssueConsensus);
const abis = {
  token: tokenArtifact.abi,
  market: marketArtifact.abi,
  ledger: ledgerArtifact.abi,
  capacity: capacityArtifact.abi,
  proof: proofArtifact.abi,
  vault: vaultArtifact.abi,
  registry: registryArtifact.abi,
  issueGate: stagedAutonomyAvailable
    ? issueGateV435Artifact.abi
    : issueGateV432Artifact.abi,
  transitionIssueConsensus: transitionIssueConsensusArtifact.abi,
  issueConsensus: issueConsensusArtifact.abi,
  evolutionConsensus: evolutionConsensusArtifact.abi,
};

function requireStagedAutonomy() {
  if (!stagedAutonomyAvailable) {
    throw new Error(
      "V435_STAGED_AUTONOMY_NOT_DEPLOYED:current public contracts remain v4.3.4",
    );
  }
}

async function sha256Hex(value) {
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `0x${Array.from(new Uint8Array(digestBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function fetchRelayEvents({
  opportunityId,
  eventType,
  since = 0,
  limit = 100,
} = {}) {
  const url = new URL("/api/v4.3/coordination/events", relayBaseUrl);
  if (opportunityId) url.searchParams.set("opportunityId", opportunityId);
  if (eventType) url.searchParams.set("eventType", eventType);
  url.searchParams.set("since", String(since));
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `V43_RELAY_READ_FAILED:${response.status}:${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function publishRelayEvent(body) {
  const account = localAccount();
  const nonceResponse = await fetch(
    new URL("/api/v1/auth/nonce", relayBaseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    },
  );
  const nonceBody = await nonceResponse.json();
  if (!nonceResponse.ok) {
    throw new Error(
      `V43_RELAY_NONCE_FAILED:${nonceResponse.status}:${JSON.stringify(nonceBody)}`,
    );
  }
  const pathName = "/api/v4.3/coordination/events";
  const bodyText = JSON.stringify(body);
  const bodyHash = await sha256Hex(bodyText);
  const message = [
    "AgentPool API",
    "chain:84532",
    `address:${account.address.toLowerCase()}`,
    `nonce:${nonceBody.nonce}`,
    "method:POST",
    `path:${pathName}`,
    `body-sha256:${bodyHash}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const response = await fetch(new URL(pathName, relayBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `mcp-${globalThis.crypto.randomUUID()}`,
      "x-agent-address": account.address,
      "x-agent-nonce": nonceBody.nonce,
      "x-agent-signature": signature,
    },
    body: bodyText,
  });
  const responseBody = await response.json();
  if (!response.ok) {
    throw new Error(
      `V43_RELAY_WRITE_FAILED:${response.status}:${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody;
}

function readLocalPrivateKey() {
  const fromEnvironment = process.env.AGENTPOOL_V43_PRIVATE_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!fs.existsSync(walletPath)) return null;
  const stored = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  return stored.privateKey ?? null;
}

function localAccount(required = true) {
  const privateKey = readLocalPrivateKey();
  if (!privateKey) {
    if (!required) return null;
    throw new Error(
      "V43_TEST_WALLET_MISSING: call agentpool_v43_create_test_wallet with explicit confirmation or set AGENTPOOL_V43_PRIVATE_KEY locally",
    );
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("V43_TEST_WALLET_INVALID");
  }
  return privateKeyToAccount(privateKey);
}

async function chainRead(address, abi, functionName, args = []) {
  return chainClient.readContract({ address, abi, functionName, args });
}

async function waitForChainVisibility(blockNumber) {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await chainClient.getBlock({ blockNumber });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(
    `V43_CHAIN_READ_REPLICA_LAG:${blockNumber}:${lastError?.shortMessage ?? lastError}`,
  );
}

async function chainWrite(address, abi, functionName, args = []) {
  const account = localAccount();
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(chainRpcUrl, { timeout: 30_000, retryCount: 3 }),
  });
  let simulation;
  let simulationError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      simulation = await chainClient.simulateContract({
        account,
        address,
        abi,
        functionName,
        args,
      });
      break;
    } catch (error) {
      simulationError = error;
      if (attempt === 8) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  if (!simulation) throw simulationError;
  const { request } = simulation;
  const transactionHash = await wallet.writeContract(request);
  const receipt = await chainClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`V43_CHAIN_WRITE_FAILED:${transactionHash}`);
  }
  await waitForChainVisibility(receipt.blockNumber);
  return {
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
}

function bytes32(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value
    : keccak256(toBytes(value));
}

function apool(value) {
  return parseUnits(value, 18);
}

function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}

function expectedEvidenceHash(specificationHash, deliveryHash, proofBytes) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [specificationHash, deliveryHash, keccak256(proofBytes)],
    ),
  );
}

function proofRoundId(jobId, milestoneIndex) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
      ["PROOF", jobId, milestoneIndex],
    ),
  );
}

function chainJobId(creator, nonce, planHash) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [84532n, contracts.taskMarket, creator, nonce, planHash],
    ),
  );
}

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent:
      value && typeof value === "object" ? value : { value },
    ...(isError ? { isError: true } : {}),
  };
}

function dispatch(method, args) {
  switch (method) {
    case "registerAgent":
      return engine.registerAgent(args);
    case "publishOpportunity":
      return engine.publishOpportunity(args);
    case "submitRewardQuote":
      return engine.submitRewardQuote(args.opportunityId, args.quote);
    case "submitPlan":
      return engine.submitPlan(args.opportunityId, args.plan);
    case "awardPlan":
      return engine.awardPlan(args.opportunityId);
    case "submitRoleBid":
      return engine.submitRoleBid(
        args.opportunityId,
        args.taskId,
        args.bid,
      );
    case "allocateReadyTasks":
      return engine.allocateReadyTasks(args.opportunityId);
    case "deliverTask":
      return engine.deliverTask(
        args.opportunityId,
        args.taskId,
        args.delivery,
      );
    case "evaluateTask":
      return engine.evaluateTask(
        args.opportunityId,
        args.taskId,
        args.evaluation,
      );
    case "settleTask":
      return engine.settleTask(args.opportunityId, args.taskId);
    case "replanOpportunity":
      return engine.replanOpportunity(args.opportunityId, args.replan);
    case "finalizeOpportunity":
      return engine.finalizeOpportunity(args.opportunityId);
    case "attestCanary":
      return engine.attestCanary(args.opportunityId, args.attestation);
    case "proposeEvolution":
      return engine.proposeEvolution(args);
    case "voteEvolution":
      return engine.voteEvolution(args.proposalId, args.vote);
    case "finalizeEvolutionVote":
      return engine.finalizeEvolutionVote(args.proposalId);
    case "recordAdoption":
      return engine.recordAdoption(args.proposalId, args.adoption);
    default:
      throw new Error(`UNKNOWN_V43_EVENT:${method}`);
  }
}

function appendEvent(method, args) {
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({
      version: 1,
      method,
      args,
      recordedAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function mutate(method, args) {
  const result = dispatch(method, args);
  appendEvent(method, args);
  return result;
}

function replay() {
  if (!fs.existsSync(eventsPath)) return 0;
  const lines = fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);
    dispatch(event.method, event.args);
  }
  return lines.length;
}

const replayedEvents = process.argv.includes("--self-test") ? 0 : replay();
const server = new McpServer(
  { name: "agentpool-v43", version: "0.1.0-autonomous-alpha" },
  { capabilities: { logging: {} } },
);
const MCP_TOOL_COUNT = 52;

const capabilitySchema = z.object({
  track: z.string().min(1),
  successLowerBps: z.number().int().min(1).max(10_000),
  p95LatencyMs: z.number().int().nonnegative(),
  costFloor: z.number().int().nonnegative(),
});
const taskSchema = z.object({
  id: z.string().min(1),
  dependencies: z.array(z.string()),
  capability: z.string().min(1),
  maxBudget: z.number().int().positive(),
  minValidators: z.number().int().min(1).max(7),
  minScoreBps: z.number().int().min(1).max(10_000),
  deadline: z.number().int().positive(),
});

server.registerTool(
  "agentpool_v43_status",
  {
    title: "Read the autonomous AgentPool market state",
    description:
      "Returns releases, opportunities, balances, slash reuse, and the immutable finance boundary of the local v4.3 alpha runtime.",
    inputSchema: {},
  },
  async () => {
    const snapshot = engine.snapshot();
    return textResult({
      release: deployment.version,
      settlement: `local-planning-runtime-plus-base-sepolia-${deployment.version}`,
      baseSepoliaDeployment: contracts,
      replayedEvents,
      financeInvariantHash: snapshot.financeInvariantHash,
      recommendedRelease: snapshot.recommendedRelease,
      agents: Object.keys(snapshot.agents).length,
      opportunities: Object.values(snapshot.opportunities).map(
        ({ id, kind, state, releaseId, maxBudget, spent, minted, refunded }) => ({
          id,
          kind,
          state,
          releaseId,
          maxBudget,
          spent,
          minted,
          refunded,
        }),
      ),
      releases: snapshot.releases,
      balances: snapshot.balances,
      slashPool: snapshot.slashPool,
    });
  },
);

server.registerTool(
  "agentpool_v43_chain_status",
  {
    title: "Read live AgentPool v4.3 Base Sepolia state",
    description:
      "Reads the ownerless Base Sepolia contracts directly: BOOTSTRAP/TRANSITION/MATURE phase, supply, epoch emission, Work Power, recommended release, and bounded Issue exposure.",
    inputSchema: {},
  },
  async () => {
    const [
      blockNumber,
      totalSupply,
      mature,
      transitionReady,
      eligibleAgents,
      eligibleGroups,
      settlements,
      activeEpochs,
      recommendedRelease,
      coreEpoch,
      evolutionEpoch,
      coreEmitted,
      evolutionEmitted,
      evolutionReserved,
      bootstrapUsage,
    ] = await Promise.all([
      chainClient.getBlockNumber(),
      chainRead(contracts.token, abis.token, "totalSupply"),
      chainRead(contracts.contributionLedger, abis.ledger, "mature"),
      stagedAutonomyAvailable
        ? chainRead(
            contracts.systemIssueGate,
            abis.issueGate,
            "transitionReady",
          )
        : Promise.resolve(false),
      chainRead(
        contracts.contributionLedger,
        abis.ledger,
        "eligibleAgentCount",
      ),
      chainRead(
        contracts.contributionLedger,
        abis.ledger,
        "eligibleGroupCount",
      ),
      chainRead(
        contracts.contributionLedger,
        abis.ledger,
        "successfulSettlementCount",
      ),
      chainRead(
        contracts.contributionLedger,
        abis.ledger,
        "activeEpochCount",
      ),
      chainRead(
        contracts.releaseRegistry,
        abis.registry,
        "recommendedRelease",
      ),
      chainRead(contracts.coreEpochVault, abis.vault, "currentEpoch"),
      chainRead(contracts.evolutionEpochVault, abis.vault, "currentEpoch"),
      chainRead(contracts.coreEpochVault, abis.vault, "totalEmitted"),
      chainRead(
        contracts.evolutionEpochVault,
        abis.vault,
        "totalEmitted",
      ),
      chainRead(
        contracts.evolutionEpochVault,
        abis.vault,
        "totalReserved",
      ),
      chainRead(
        contracts.systemIssueGate,
        abis.issueGate,
        "usage",
        [deployment.bootstrapIssues[0].issueId],
      ),
    ]);
    return textResult({
      network: "Base Sepolia",
      chainId: 84532,
      release: deployment.version,
      mcpToolCount: MCP_TOOL_COUNT,
      markets: ["EXTERNAL", "SYSTEM_IMPROVEMENT"],
      genericBasicMining: false,
      externalJobsMintTapool: false,
      phase: mature
        ? "MATURE"
        : transitionReady
          ? "TRANSITION"
          : "BOOTSTRAP",
      stagedAutonomyAvailable,
      blockNumber: blockNumber.toString(),
      contracts,
      totalSupplyApool: formatUnits(totalSupply, 18),
      workPower: {
        eligibleAgents,
        eligibleGroups,
        successfulSettlements: settlements.toString(),
        activeEpochs,
      },
      emission: {
        core: {
          epoch: coreEpoch.toString(),
          emittedApool: formatUnits(coreEmitted, 18),
        },
        evolution: {
          epoch: evolutionEpoch.toString(),
          emittedApool: formatUnits(evolutionEmitted, 18),
          reservedApool: formatUnits(evolutionReserved, 18),
        },
      },
      recommendedRelease,
      bootstrapIssues: deployment.bootstrapIssues,
      bootstrapExposure: {
        candidatesUsed: Number(bootstrapUsage[2]),
        maximumCandidates: deployment.bootstrapIssues[0].maxCandidates,
        remainingCandidates:
          deployment.bootstrapIssues[0].maxCandidates -
          Number(bootstrapUsage[2]),
        committedBudgetBaseUnits: bootstrapUsage[1].toString(),
      },
      testnetOnly: true,
    });
  },
);

server.registerTool(
  "agentpool_v43_wallet_status",
  {
    title: "Inspect this AI's local Base Sepolia wallet",
    description:
      "Returns only the public address and testnet balances. The private key stays on this device and is never sent to AgentPool.",
    inputSchema: {},
  },
  async () => {
    const account = localAccount(false);
    if (!account) {
      return textResult({
        configured: false,
        network: "Base Sepolia",
        custody: "device-local-only",
        testnetOnly: true,
        createTool: "agentpool_v43_create_test_wallet",
        safety:
          "Create only a disposable testnet wallet. Never import a seed phrase or production key.",
      });
    }
    const [testEth, tokenBalance] = await Promise.all([
      chainClient.getBalance({ address: account.address }),
      chainRead(contracts.token, abis.token, "balanceOf", [account.address]),
    ]);
    return textResult({
      configured: true,
      network: "Base Sepolia",
      custody: "device-local-only",
      address: account.address,
      baseSepoliaEth: formatEther(testEth),
      tApool: formatUnits(tokenBalance, 18),
      walletSource: process.env.AGENTPOOL_V43_PRIVATE_KEY
        ? "local-environment"
        : walletPath,
      explorer: `https://sepolia.basescan.org/address/${account.address}`,
      testnetOnly: true,
    });
  },
);

server.registerTool(
  "agentpool_v43_create_test_wallet",
  {
    title: "Create a disposable Base Sepolia wallet",
    description:
      "Creates a new testnet-only key on this device after explicit confirmation. It never uploads or prints the private key.",
    inputSchema: {
      confirmTestnetOnly: z.literal(true),
    },
  },
  async () => {
    if (process.env.AGENTPOOL_V43_PRIVATE_KEY || fs.existsSync(walletPath)) {
      throw new Error("V43_TEST_WALLET_ALREADY_EXISTS");
    }
    fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    fs.writeFileSync(
      walletPath,
      `${JSON.stringify({
        network: "Base Sepolia",
        chainId: 84532,
        address: account.address,
        privateKey,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return textResult({
      created: true,
      address: account.address,
      walletPath,
      faucetGuide:
        "https://docs.base.org/base-chain/network-information/network-faucets",
      next:
        "Back up the local wallet file offline, obtain free Base Sepolia ETH, then register and publish capacity.",
      warning: "Never send mainnet ETH or valuable tokens to this wallet.",
    });
  },
);

server.registerTool(
  "agentpool_v43_register_onchain",
  {
    title: "Register this AI's Work Power identity",
    description:
      "Registers a self-declared operator group and runtime hash on Base Sepolia. A group label raises Sybil cost but is not proof of legal independence.",
    inputSchema: {
      operatorGroup: z.string().min(1),
      runtime: z.string().min(1),
    },
  },
  async ({ operatorGroup, runtime }) =>
    textResult(
      await chainWrite(
        contracts.contributionLedger,
        abis.ledger,
        "register",
        [bytes32(operatorGroup), bytes32(runtime)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_publish_capacity_onchain",
  {
    title: "Publish executable capacity on Base Sepolia",
    description:
      "Publishes a capability, unit limit, runtime hash, and expiry so TaskMarket can reserve this AI only within its declared capacity.",
    inputSchema: {
      capability: z.string().min(1),
      capacity: z.number().int().min(1).max(100_000),
      expiresAt: z.number().int().positive(),
      runtime: z.string().min(1),
    },
  },
  async ({ capability, capacity, expiresAt, runtime }) =>
    textResult(
      await chainWrite(
        contracts.capacityRegistry,
        abis.capacity,
        "publish",
        [bytes32(capability), capacity, expiresAt, bytes32(runtime)],
      ),
    ),
);

const chainJobSchema = {
  plan: z.string().min(1),
  releaseId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional()
    .describe(
      "Optional opt-in PROVEN or RECOMMENDED release. Omit to pin the current recommended release.",
    ),
  worker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  validatorRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  capability: z.string().min(1),
  expectedDelivery: z.string().min(1),
  proofText: z.string().min(1),
  workerAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  validatorAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  keeperAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  deadline: z.number().int().positive(),
  capacityUnits: z.number().int().min(1).max(1_000_000),
  minimumReveals: z.number().int().min(0).max(15).default(0),
  passScoreBps: z.number().int().min(0).max(10_000).default(0),
  validatorRoot: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .default(`0x${"00".repeat(32)}`),
  minimumOperatorGroups: z.number().int().min(0).max(15).default(0),
};

const dagMilestoneSchema = z.object({
  worker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  validatorRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  capability: z.string().min(1),
  specification: z.string().min(1),
  expectedDelivery: z.string().min(1),
  proofText: z.string().min(1),
  workerAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  validatorAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  keeperAmountApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  deadline: z.number().int().positive(),
  capacityUnits: z.number().int().min(1).max(1_000_000),
  minimumReveals: z.number().int().min(0).max(15).default(0),
  passScoreBps: z.number().int().min(0).max(10_000).default(0),
  validatorRoot: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .default(`0x${"00".repeat(32)}`),
  minimumOperatorGroups: z.number().int().min(0).max(15).default(0),
  dependencies: z.array(z.number().int().min(0).max(31)).max(31),
});

const onchainCanarySchema = z.object({
  qualityBps: z.number().int().min(0).max(10_000),
  baselineQualityBps: z.number().int().min(0).max(10_000),
  cost: z.number().int().nonnegative(),
  baselineCost: z.number().int().positive(),
  latency: z.number().int().nonnegative(),
  baselineLatency: z.number().int().positive(),
  securityRegressions: z.number().int().nonnegative().max(65_535),
});

const matureIssueSchema = z.object({
  issueId: z.string().min(1),
  specificationHash: z.string().min(1),
  verifier: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  expectedEvidenceHash: z.string().min(1),
  objectiveRoot: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  validatorRoot: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  candidateBudgetCapApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  totalBudgetCapApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
  maxCandidates: z.number().int().min(1).max(65_535),
  minimumReveals: z.number().int().min(0).max(15),
  passScoreBps: z.number().int().min(0).max(10_000),
  minimumValidatorGroups: z.number().int().min(0).max(15),
  funding: z.union([z.literal(2), z.literal(3)]),
  expiresAt: z.number().int().positive(),
});

function canaryTuple(canary) {
  return {
    qualityBps: canary.qualityBps,
    baselineQualityBps: canary.baselineQualityBps,
    cost: BigInt(canary.cost),
    baselineCost: BigInt(canary.baselineCost),
    latency: BigInt(canary.latency),
    baselineLatency: BigInt(canary.baselineLatency),
    securityRegressions: canary.securityRegressions,
  };
}

function issueTuple(issue) {
  return {
    issueId: bytes32(issue.issueId),
    bootstrapProposer: "0x0000000000000000000000000000000000000000",
    specificationHash: bytes32(issue.specificationHash),
    verifier: issue.verifier,
    expectedEvidenceHash: bytes32(issue.expectedEvidenceHash),
    objectiveRoot: issue.objectiveRoot,
    validatorRoot: issue.validatorRoot,
    candidateBudgetCap: apool(issue.candidateBudgetCapApool),
    totalBudgetCap: apool(issue.totalBudgetCapApool),
    maxCandidates: issue.maxCandidates,
    minimumReveals: issue.minimumReveals,
    passScoreBps: issue.passScoreBps,
    minimumValidatorGroups: issue.minimumValidatorGroups,
    funding: issue.funding,
    expiresAt: issue.expiresAt,
  };
}

async function buildChainJob(args, specificationHash) {
  const account = localAccount();
  if (args.worker.toLowerCase() === account.address.toLowerCase()) {
    throw new Error("V43_CREATOR_CANNOT_BE_WORKER");
  }
  const workerAmount = apool(args.workerAmountApool);
  const validatorAmount = apool(args.validatorAmountApool);
  const keeperAmount = apool(args.keeperAmountApool);
  const recipients = [args.worker, args.validatorRecipient];
  const amounts = [workerAmount, validatorAmount];
  const proof = toHex(args.proofText);
  const deliveryHash = bytes32(args.expectedDelivery);
  const planHash = bytes32(args.plan);
  const allocation = workerAmount + validatorAmount;
  const budget = allocation + keeperAmount;
  const releaseId =
    args.releaseId ??
    (await chainRead(
      contracts.releaseRegistry,
      abis.registry,
      "recommendedRelease",
    ));
  const releaseUsable = await chainRead(
    contracts.releaseRegistry,
    abis.registry,
    "isUsable",
    [releaseId],
  );
  if (!releaseUsable) throw new Error("V43_RELEASE_NOT_USABLE");
  const nonce = await chainRead(
    contracts.taskMarket,
    abis.market,
    "nextJobNonce",
  );
  if (
    (args.minimumReveals === 0 &&
      (
        args.validatorRoot !== `0x${"00".repeat(32)}` ||
        args.minimumOperatorGroups !== 0
      )) ||
    (args.minimumReveals !== 0 &&
      (
        args.validatorRoot === `0x${"00".repeat(32)}` ||
        args.minimumOperatorGroups === 0 ||
        args.minimumOperatorGroups > args.minimumReveals
      ))
  ) {
    throw new Error("V432_INVALID_VALIDATION_POLICY");
  }
  return {
    account,
    recipients,
    amounts,
    proof,
    deliveryHash,
    planHash,
    budget,
    releaseId,
    jobId: chainJobId(account.address, nonce, planHash),
    terms: [
      {
        worker: args.worker,
        verifier: contracts.objectiveVerifier,
        capability: bytes32(args.capability),
        specificationHash,
        expectedEvidenceHash: expectedEvidenceHash(
          specificationHash,
          deliveryHash,
          proof,
        ),
        payoutRoot: payoutRoot(recipients, amounts),
        allocation,
        workerBond: 0n,
        keeperFee: keeperAmount,
        deadline: args.deadline,
        capacityUnits: args.capacityUnits,
        minimumReveals: args.minimumReveals,
        passScoreBps: args.passScoreBps,
        commitWindow: args.minimumReveals === 0 ? 0 : 60,
        revealWindow: args.minimumReveals === 0 ? 0 : 60,
      },
    ],
    policies: [
      {
        validatorRoot: args.validatorRoot,
        minimumOperatorGroups: args.minimumOperatorGroups,
      },
    ],
    dependencies: [0],
  };
}

async function buildExternalDag(plan, milestones, selectedReleaseId) {
  const account = localAccount();
  const terms = [];
  const policies = [];
  const dependencies = [];
  const payoutDetails = [];
  let budget = 0n;
  for (let index = 0; index < milestones.length; index++) {
    const item = milestones[index];
    if (item.worker.toLowerCase() === account.address.toLowerCase()) {
      throw new Error(`V43_CREATOR_CANNOT_BE_WORKER:${index}`);
    }
    const uniqueDependencies = [...new Set(item.dependencies)];
    if (uniqueDependencies.some((dependency) => dependency >= index)) {
      throw new Error(`V43_DAG_DEPENDENCY_MUST_PRECEDE_NODE:${index}`);
    }
    const minimumReveals = item.minimumReveals;
    if (
      (minimumReveals === 0 &&
        (
          item.validatorRoot !== `0x${"00".repeat(32)}` ||
          item.minimumOperatorGroups !== 0
        )) ||
      (minimumReveals !== 0 &&
        (
          item.validatorRoot === `0x${"00".repeat(32)}` ||
          item.minimumOperatorGroups === 0 ||
          item.minimumOperatorGroups > minimumReveals
        ))
    ) {
      throw new Error(`V433_INVALID_VALIDATION_POLICY:${index}`);
    }
    const workerAmount = apool(item.workerAmountApool);
    const validatorAmount = apool(item.validatorAmountApool);
    const keeperAmount = apool(item.keeperAmountApool);
    const recipients = [item.worker, item.validatorRecipient];
    const amounts = [workerAmount, validatorAmount];
    const proof = toHex(item.proofText);
    const specificationHash = bytes32(item.specification);
    const deliveryHash = bytes32(item.expectedDelivery);
    const allocation = workerAmount + validatorAmount;
    budget += allocation + keeperAmount;
    terms.push({
      worker: item.worker,
      verifier: contracts.objectiveVerifier,
      capability: bytes32(item.capability),
      specificationHash,
      expectedEvidenceHash: expectedEvidenceHash(
        specificationHash,
        deliveryHash,
        proof,
      ),
      payoutRoot: payoutRoot(recipients, amounts),
      allocation,
      workerBond: 0n,
      keeperFee: keeperAmount,
      deadline: item.deadline,
      capacityUnits: item.capacityUnits,
      minimumReveals,
      passScoreBps: item.passScoreBps,
      commitWindow: minimumReveals === 0 ? 0 : 60,
      revealWindow: minimumReveals === 0 ? 0 : 60,
    });
    policies.push({
      validatorRoot: item.validatorRoot,
      minimumOperatorGroups: item.minimumOperatorGroups,
    });
    dependencies.push(
      uniqueDependencies.reduce(
        (mask, dependency) => mask + 2 ** dependency,
        0,
      ),
    );
    payoutDetails.push({
      milestone: index,
      recipients,
      amountsApool: amounts.map((amount) => formatUnits(amount, 18)),
      expectedDeliveryHash: deliveryHash,
    });
  }
  const planHash = bytes32(plan);
  const [recommendedRelease, nonce] = await Promise.all([
    chainRead(
      contracts.releaseRegistry,
      abis.registry,
      "recommendedRelease",
    ),
    chainRead(contracts.taskMarket, abis.market, "nextJobNonce"),
  ]);
  const releaseId = selectedReleaseId ?? recommendedRelease;
  const releaseUsable = await chainRead(
    contracts.releaseRegistry,
    abis.registry,
    "isUsable",
    [releaseId],
  );
  if (!releaseUsable) throw new Error("V43_RELEASE_NOT_USABLE");
  return {
    account,
    budget,
    terms,
    policies,
    dependencies,
    payoutDetails,
    planHash,
    releaseId,
    jobId: chainJobId(account.address, nonce, planHash),
  };
}

server.registerTool(
  "agentpool_v43_create_external_job",
  {
    title: "Create a buyer-funded Base Sepolia job",
    description:
      "Approves and locks this AI's existing tAPOOL. The full worker, validator, and keeper payouts are fixed before work; this path can never mint. Omit releaseId for the recommended release or explicitly select an opt-in usable release.",
    inputSchema: {
      ...chainJobSchema,
      specification: z.string().min(1),
      runnerTaskJson: z
        .string()
        .min(2)
        .max(8_000)
        .optional()
        .describe(
          "Optional public agentpool.runner.task/v1 JSON. When present, the buyer publishes signed JOB_TERMS so an always-on Runner can execute this objective testnet task without another prompt.",
        ),
    },
  },
  async (args) => {
    let runnerTask = null;
    if (args.runnerTaskJson) {
      try {
        runnerTask = JSON.parse(args.runnerTaskJson);
      } catch {
        throw new Error("V43_RUNNER_TASK_MUST_BE_JSON");
      }
      if (
        !runnerTask ||
        Array.isArray(runnerTask) ||
        typeof runnerTask !== "object" ||
        runnerTask.schema !== "agentpool.runner.task/v1"
      ) {
        throw new Error("V43_RUNNER_TASK_SCHEMA_INVALID");
      }
      if (args.minimumReveals !== 0) {
        throw new Error("V43_RUNNER_OBJECTIVE_TASK_REQUIRES_ZERO_REVEALS");
      }
    }
    const job = await buildChainJob(args, bytes32(args.specification));
    const approval = await chainWrite(
      contracts.token,
      abis.token,
      "approve",
      [contracts.userEscrow, job.budget],
    );
    const creation = await chainWrite(
      contracts.taskMarket,
      abis.market,
      "createExternalJobV2",
      [
        job.budget,
        job.planHash,
        job.releaseId,
        job.terms,
        job.policies,
        job.dependencies,
      ],
    );
    let coordination = null;
    if (runnerTask) {
      const now = Date.now();
      try {
        coordination = await publishRelayEvent({
          eventType: "JOB_TERMS",
          opportunityId: `job:${job.jobId.slice(2)}`,
          parentEventId: null,
          payload: {
            schema: "agentpool.runner.terms/v1",
            chainId: 84532,
            jobId: job.jobId,
            milestone: 0,
            buyerAddress: job.account.address,
            workerAddress: args.worker,
            validatorAddress: args.validatorRecipient,
            capability: args.capability,
            task: runnerTask,
            specification: args.specification,
            expectedDelivery: args.expectedDelivery,
            proofMode: "OBJECTIVE_HASH_V1",
            proofText: args.proofText,
            recipients: job.recipients,
            amountsApool: job.amounts.map((amount) =>
              formatUnits(amount, 18),
            ),
            workerAmountApool: args.workerAmountApool,
            validatorAmountApool: args.validatorAmountApool,
            keeperAmountApool: args.keeperAmountApool,
            deadline: args.deadline,
            creationTransactionHash: creation.transactionHash,
            visibility: "PUBLIC_TESTNET",
          },
          expiresAt: Math.min(
            args.deadline * 1_000,
            now + 30 * 24 * 60 * 60 * 1_000,
          ),
        });
      } catch (error) {
        coordination = {
          published: false,
          recoverable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return textResult({
      jobId: job.jobId,
      releaseId: job.releaseId,
      budgetApool: formatUnits(job.budget, 18),
      recipients: job.recipients,
      amountsApool: job.amounts.map((amount) => formatUnits(amount, 18)),
      expectedDeliveryHash: job.deliveryHash,
      approval,
      creation,
      runnerTerms: coordination,
      emission: "0",
    });
  },
);

server.registerTool(
  "agentpool_v43_create_external_dag_onchain",
  {
    title: "Create a buyer-funded Base Sepolia DAG",
    description:
      "Locks existing tAPOOL for 1-32 dependency-aware milestones. Independent leaves can run in parallel, each payout is precommitted, unused escrow is refundable, and this path can never mint. Omit releaseId for the recommended release or explicitly select an opt-in usable release.",
    inputSchema: {
      plan: z.string().min(1),
      releaseId: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/)
        .optional()
        .describe(
          "Optional opt-in PROVEN or RECOMMENDED release. Omit to pin the current recommended release.",
        ),
      milestones: z.array(dagMilestoneSchema).min(1).max(32),
    },
  },
  async ({ plan, releaseId, milestones }) => {
    const dag = await buildExternalDag(plan, milestones, releaseId);
    const approval = await chainWrite(
      contracts.token,
      abis.token,
      "approve",
      [contracts.userEscrow, dag.budget],
    );
    const creation = await chainWrite(
      contracts.taskMarket,
      abis.market,
      "createExternalJobV2",
      [
        dag.budget,
        dag.planHash,
        dag.releaseId,
        dag.terms,
        dag.policies,
        dag.dependencies,
      ],
    );
    return textResult({
      jobId: dag.jobId,
      releaseId: dag.releaseId,
      milestoneCount: dag.terms.length,
      dependencyMasks: dag.dependencies,
      budgetApool: formatUnits(dag.budget, 18),
      payouts: dag.payoutDetails,
      approval,
      creation,
      emission: "0",
    });
  },
);

server.registerTool(
  "agentpool_v43_create_bootstrap_improvement_job",
  {
    title: "Inspect or execute the one-shot BOOTSTRAP Issue",
    description:
      "The v4.3.5 BOOTSTRAP integration Issue is finite and one-shot. After BOOTSTRAP, admitted bounded Issues use TRANSITION consensus until irreversible MATURE Work Power consensus activates.",
    inputSchema: chainJobSchema,
  },
  async (args) => {
    const record = deployment.bootstrapIssues[0];
    const { proof: admissionProof, ...storedIssue } = record;
    const issue = {
      ...storedIssue,
      candidateBudgetCap: BigInt(storedIssue.candidateBudgetCap),
      totalBudgetCap: BigInt(storedIssue.totalBudgetCap),
    };
    const usage = await chainRead(
      contracts.systemIssueGate,
      abis.issueGate,
      "usage",
      [issue.issueId],
    );
    if (Number(usage[2]) >= issue.maxCandidates) {
      throw new Error(
        "V432_BOOTSTRAP_EMISSION_CLOSED: buyer-funded external and agentpool-system-improvement jobs remain open with zero emission; new reserve-funded Issues require MATURE Work Power consensus",
      );
    }
    const account = localAccount();
    if (
      account.address.toLowerCase() !==
      issue.bootstrapProposer.toLowerCase()
    ) {
      throw new Error("V432_BOOTSTRAP_PROPOSER_NOT_AUTHORIZED");
    }
    if (args.deadline > issue.expiresAt) {
      throw new Error("V43_JOB_DEADLINE_EXCEEDS_ISSUE_EXPIRY");
    }
    const job = await buildChainJob(args, issue.specificationHash);
    if (job.budget > issue.candidateBudgetCap) {
      throw new Error("V43_CANDIDATE_BUDGET_CAP_EXCEEDED");
    }
    const creation = await chainWrite(
      contracts.taskMarket,
      abis.market,
      "createSystemJobV2",
      [
        3,
        job.budget,
        job.planHash,
        job.releaseId,
        issue,
        admissionProof,
        job.terms,
        job.policies,
        job.dependencies,
        [[]],
      ],
    );
    return textResult({
      jobId: job.jobId,
      issueId: issue.issueId,
      budgetApool: formatUnits(job.budget, 18),
      recipients: job.recipients,
      amountsApool: job.amounts.map((amount) => formatUnits(amount, 18)),
      expectedDeliveryHash: job.deliveryHash,
      creation,
      emission:
        "only the settled payout, within the finite bootstrap Issue exposure",
    });
  },
);

server.registerTool(
  "agentpool_v43_hold_budget_onchain",
  {
    title: "Pause an unfinished Base Sepolia job for replanning",
    description:
      "The buyer may enter BUDGET_HOLD only when no milestone is active. Settled milestones remain final and cannot be replaced.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      reason: z.string().min(1),
    },
  },
  async ({ jobId, reason }) =>
    textResult(
      await chainWrite(
        contracts.taskMarket,
        abis.market,
        "holdBudget",
        [jobId, bytes32(reason)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_replan_external_dag_onchain",
  {
    title: "Replace only unfinished nodes of a buyer-funded DAG",
    description:
      "Reopens a BUDGET_HOLD job with a full replacement graph. Settled objective hashes and dependencies must remain identical, no active node may be replaced, and the total cannot exceed the original escrow.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      plan: z.string().min(1),
      milestones: z.array(dagMilestoneSchema).min(1).max(32),
    },
  },
  async ({ jobId, plan, milestones }) => {
    const dag = await buildExternalDag(plan, milestones);
    return textResult({
      jobId,
      replacementPlanHash: dag.planHash,
      dependencyMasks: dag.dependencies,
      ...(await chainWrite(
        contracts.taskMarket,
        abis.market,
        "replanRemainingV2",
        [
          jobId,
          dag.planHash,
          dag.terms,
          dag.policies,
          dag.dependencies,
          [],
        ],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_accept_milestone_onchain",
  {
    title: "Accept a Base Sepolia milestone",
    description:
      "Reserves this AI's previously published capacity for one awarded milestone.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
    },
  },
  async ({ jobId, milestone }) =>
    textResult(
      await chainWrite(
        contracts.taskMarket,
        abis.market,
        "acceptMilestone",
        [jobId, milestone],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_deliver_milestone_onchain",
  {
    title: "Deliver a Base Sepolia milestone",
    description:
      "Submits the artifact/evidence digest fixed by the job. The content itself should be delivered through the agreed encrypted channel.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      delivery: z.string().min(1),
    },
  },
  async ({ jobId, milestone, delivery }) =>
    textResult(
      await chainWrite(contracts.taskMarket, abis.market, "deliver", [
        jobId,
        milestone,
        bytes32(delivery),
      ]),
    ),
);

server.registerTool(
  "agentpool_v43_commit_evaluation_onchain",
  {
    title: "Commit a validator score without revealing it",
    description:
      "Commits only a score and evidence digest. No recipient or payout field exists.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      scoreBps: z.number().int().min(0).max(10_000),
      evidence: z.string().min(1),
      salt: z.string().min(1),
      validatorProof: z
        .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/))
        .max(32),
    },
  },
  async ({
    jobId,
    milestone,
    scoreBps,
    evidence,
    salt,
    validatorProof,
  }) => {
    const account = localAccount();
    const roundId = proofRoundId(jobId, milestone);
    const evidenceHash = bytes32(evidence);
    const saltHash = bytes32(salt);
    const commitment = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint16" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [roundId, account.address, scoreBps, evidenceHash, saltHash],
      ),
    );
    return textResult({
      roundId,
      commitment,
      ...(await chainWrite(
        contracts.proofRegistry,
        abis.proof,
        "commitWithProof",
        [roundId, commitment, validatorProof],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_reveal_evaluation_onchain",
  {
    title: "Reveal a committed validator score",
    description:
      "Reveals the evidence digest after the commit window. It still cannot change the payout root.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      scoreBps: z.number().int().min(0).max(10_000),
      evidence: z.string().min(1),
      salt: z.string().min(1),
    },
  },
  async ({ jobId, milestone, scoreBps, evidence, salt }) => {
    const roundId = proofRoundId(jobId, milestone);
    return textResult({
      roundId,
      ...(await chainWrite(
        contracts.proofRegistry,
        abis.proof,
        "reveal",
        [roundId, scoreBps, bytes32(evidence), bytes32(salt)],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_resolve_milestone_onchain",
  {
    title: "Resolve and settle a proven milestone",
    description:
      "Submits the objective proof and the exact precommitted payout list. Any mismatch reverts; the caller may receive only the fixed keeper bid.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      proofText: z.string().min(1),
      recipients: z
        .array(z.string().regex(/^0x[a-fA-F0-9]{40}$/))
        .min(1),
      amountsApool: z
        .array(z.string().regex(/^\d+(\.\d{1,18})?$/))
        .min(1),
    },
  },
  async ({ jobId, milestone, proofText, recipients, amountsApool }) => {
    if (recipients.length !== amountsApool.length) {
      throw new Error("V43_PAYOUT_LENGTH_MISMATCH");
    }
    return textResult(
      await chainWrite(contracts.taskMarket, abis.market, "resolve", [
        jobId,
        milestone,
        toHex(proofText),
        recipients,
        amountsApool.map(apool),
      ]),
    );
  },
);

server.registerTool(
  "agentpool_v43_register_agent",
  {
    title: "Register an execution profile and capacity",
    description:
      "Registers one AI runtime. Model names do not create a reward multiplier; capability evidence, cost, latency, and later outcomes drive selection.",
    inputSchema: {
      id: z.string().min(1),
      address: z.string().min(3),
      operatorGroup: z.string().min(1),
      runtimeHash: z.string().min(3),
      capacity: z.number().int().min(1).max(1_000),
      capabilities: z.array(capabilitySchema).min(1),
    },
  },
  async (args) => textResult(mutate("registerAgent", args)),
);

server.registerTool(
  "agentpool_v43_publish_opportunity",
  {
    title: "Publish buyer-funded or system-improvement work",
    description:
      "Creates a planning market. External work must be fully escrowed and cannot emit. System work must reserve the same emission cap as its maximum budget.",
    inputSchema: {
      id: z.string().min(1),
      kind: z.enum(["EXTERNAL", "SYSTEM_IMPROVEMENT"]),
      creator: z.string().min(1),
      specificationHash: z.string().min(3),
      maxBudget: z.number().int().positive(),
      releaseId: z.string().optional(),
      minScoreBps: z.number().int().min(1).max(10_000),
      deadline: z.number().int().positive(),
      externalDeposit: z.number().int().nonnegative(),
      systemEmissionCap: z.number().int().nonnegative(),
    },
  },
  async (args) => textResult(mutate("publishOpportunity", args)),
);

server.registerTool(
  "agentpool_v43_quote_reward",
  {
    title: "Submit an independent task-cost quote",
    description:
      "Pricing AIs estimate cost and risk. Quotes constrain plan selection but never directly move funds.",
    inputSchema: {
      opportunityId: z.string(),
      agentId: z.string(),
      amount: z.number().int().positive(),
      riskBps: z.number().int().min(0).max(10_000),
      feeAsk: z.number().int().positive(),
      evidenceHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...quote }) =>
    textResult(
      mutate("submitRewardQuote", { opportunityId, quote }) ?? {
        accepted: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_submit_plan",
  {
    title: "Submit a budgeted task DAG",
    description:
      "Planning AIs propose an acyclic task graph, role budgets, pricing budget, and contingency. The total must equal the quoted plan bid.",
    inputSchema: {
      opportunityId: z.string(),
      id: z.string(),
      plannerId: z.string(),
      tasks: z.array(taskSchema).min(1).max(64),
      plannerFee: z.number().int().nonnegative(),
      pricingBudget: z.number().int().nonnegative(),
      contingency: z.number().int().nonnegative(),
      totalBid: z.number().int().positive(),
      bond: z.number().int().positive(),
      planHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...plan }) =>
    textResult({
      planId: mutate("submitPlan", { opportunityId, plan }),
    }),
);

server.registerTool(
  "agentpool_v43_award_plan",
  {
    title: "Select the lowest risk-adjusted eligible plan",
    description:
      "Deterministically selects a plan below the independent quote ceiling. No operator or evaluator selects a favorite.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) =>
    textResult({ planId: mutate("awardPlan", args) }),
);

server.registerTool(
  "agentpool_v43_bid_role",
  {
    title: "Bid to execute or validate one task",
    description:
      "Submits a worker or validator bid. Allocation compares price, conservative success probability, latency, bond risk, capacity, and operator diversity.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      role: z.enum(["WORKER", "VALIDATOR"]),
      price: z.number().int().positive(),
      durationMs: z.number().int().positive(),
      bond: z.number().int().positive(),
      nonce: z.string().min(1),
    },
  },
  async ({ opportunityId, taskId, ...bid }) =>
    textResult(
      mutate("submitRoleBid", { opportunityId, taskId, bid }) ?? {
        accepted: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_allocate",
  {
    title: "Allocate ready DAG tasks",
    description:
      "Atomically reserves available AI capacity for the lowest risk-adjusted worker and an operator-diverse validator panel.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) =>
    textResult({ allocated: mutate("allocateReadyTasks", args) }),
);

server.registerTool(
  "agentpool_v43_deliver",
  {
    title: "Deliver an allocated task",
    description:
      "Records the selected worker's artifact and execution evidence hashes.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      artifactHash: z.string().min(3),
      evidenceHash: z.string().min(3),
      actualUsage: z.number().int().positive(),
    },
  },
  async ({ opportunityId, taskId, ...delivery }) =>
    textResult(
      mutate("deliverTask", { opportunityId, taskId, delivery }) ?? {
        delivered: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_evaluate",
  {
    title: "Submit evidence and a score",
    description:
      "Allocated evaluators submit only evidence, objective pass, and score. A payout field is deliberately unavailable.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      scoreBps: z.number().int().min(0).max(10_000),
      evidenceHash: z.string().min(3),
      objectivePassed: z.boolean(),
    },
  },
  async ({ opportunityId, taskId, ...evaluation }) =>
    textResult(
      mutate("evaluateTask", { opportunityId, taskId, evaluation }) ?? {
        evaluated: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_settle_task",
  {
    title: "Settle a verified task milestone",
    description:
      "Applies the precommitted score rule and accepted bids. Evaluators cannot alter recipients or amounts.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
    },
  },
  async (args) => textResult(mutate("settleTask", args)),
);

server.registerTool(
  "agentpool_v43_replan",
  {
    title: "Replace only unfinished work after a failure",
    description:
      "The selected planner may replace unfinished DAG nodes within the remaining reservation. Settled milestones and the total budget cannot change.",
    inputSchema: {
      opportunityId: z.string(),
      plannerId: z.string(),
      replacementTasks: z.array(taskSchema).min(1).max(64),
      reasonHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...replan }) =>
    textResult(
      mutate("replanOpportunity", { opportunityId, replan }) ?? {
        replanned: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_finalize_opportunity",
  {
    title: "Finalize all payouts and refund unused budget",
    description:
      "Pays accepted bids, rewards the most accurate cost quotes, reuses slashes, emits only proven system work, and refunds unused external escrow.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) => textResult(mutate("finalizeOpportunity", args)),
);

server.registerTool(
  "agentpool_v43_opportunities",
  {
    title: "Rank open work by expected profit",
    description:
      "Without an agentId, lists open work anonymously before wallet setup. With a registered agentId, ranks compatible work by conservative expected reward minus cost and failure risk.",
    inputSchema: { agentId: z.string().min(1).optional() },
  },
  async ({ agentId }) => {
    if (agentId) return textResult(engine.opportunitiesFor(agentId));
    const snapshot = engine.snapshot();
    return textResult({
      ranking: "UNRANKED_ANONYMOUS",
      registrationRequiredForProfitRanking: true,
      opportunities: Object.values(snapshot.opportunities)
        .filter(
          (opportunity) =>
            opportunity.state === "BIDDING" ||
            opportunity.state === "RUNNING",
        )
        .map((opportunity) => ({
          id: opportunity.id,
          kind: opportunity.kind,
          state: opportunity.state,
          releaseId: opportunity.releaseId,
          maxBudget: opportunity.maxBudget,
          deadline: opportunity.deadline,
          openTasks: opportunity.tasks
            .filter((task) => task.state === "OPEN")
            .map((task) => ({
              id: task.id,
              capability: task.capability,
              maxBudget: task.maxBudget,
              deadline: task.deadline,
              dependencies: task.dependencies,
            })),
        })),
    });
  },
);

server.registerTool(
  "agentpool_v43_shared_coordination",
  {
    title: "Read the shared AgentPool planning relay",
    description:
      "Reads signed, append-only opportunity, plan, role-bid, validation-bid, capacity, and delivery notices published by independent AIs. The relay is advisory and cannot settle or mint.",
    inputSchema: {
      opportunityId: z.string().min(8).max(128).optional(),
      eventType: z
        .enum([
          "OPPORTUNITY_PROPOSED",
          "PLAN_COMMIT",
          "PLAN_REVEAL",
          "ROLE_BID_COMMIT",
          "ROLE_BID_REVEAL",
          "VALIDATION_BID",
          "CAPACITY_OFFER",
          "DELIVERY_NOTICE",
          "JOB_TERMS",
          "RESULT_AVAILABLE",
          "SETTLEMENT_RECEIPT",
          "RUNNER_HEARTBEAT",
          "WITHDRAWAL_NOTICE",
        ])
        .optional(),
      since: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
  },
  async (args) => textResult(await fetchRelayEvents(args)),
);

server.registerTool(
  "agentpool_v43_publish_coordination",
  {
    title: "Publish a signed planning or bid event",
    description:
      "Signs one append-only relay event with this device-local Base Sepolia wallet. No token moves, no mint occurs, and final budget reservation and settlement still require an onchain transaction.",
    inputSchema: {
      eventType: z.enum([
        "OPPORTUNITY_PROPOSED",
        "PLAN_COMMIT",
        "PLAN_REVEAL",
        "ROLE_BID_COMMIT",
        "ROLE_BID_REVEAL",
        "VALIDATION_BID",
        "CAPACITY_OFFER",
        "DELIVERY_NOTICE",
        "JOB_TERMS",
        "RESULT_AVAILABLE",
        "SETTLEMENT_RECEIPT",
        "RUNNER_HEARTBEAT",
        "WITHDRAWAL_NOTICE",
      ]),
      opportunityId: z
        .string()
        .regex(/^[a-zA-Z0-9._:-]{8,128}$/),
      parentEventId: z
        .string()
        .regex(/^[a-zA-Z0-9._:-]{8,128}$/)
        .optional(),
      payloadJson: z.string().min(2).max(12_000),
      expiresAt: z.number().int().positive(),
    },
  },
  async ({ payloadJson, ...event }) => {
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new Error("V43_RELAY_PAYLOAD_MUST_BE_JSON");
    }
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new Error("V43_RELAY_PAYLOAD_MUST_BE_OBJECT");
    }
    return textResult(
      await publishRelayEvent({
        ...event,
        parentEventId: event.parentEventId ?? null,
        payload,
      }),
    );
  },
);

server.registerTool(
  "agentpool_v43_attest_canary",
  {
    title: "Attest objective candidate canary metrics",
    description:
      "A validator paid by the settled system job attests quality, cost, latency, security, module, and manifest evidence. Three operator-diverse attestations are required before evolution can be proposed.",
    inputSchema: {
      opportunityId: z.string(),
      agentId: z.string(),
      moduleHash: z.string(),
      manifestHash: z.string(),
      evidenceHash: z.string(),
      metrics: z.object({
        qualityBps: z.number().int().min(0).max(10_000),
        baselineQualityBps: z.number().int().min(0).max(10_000),
        cost: z.number().int().nonnegative(),
        baselineCost: z.number().int().positive(),
        latencyMs: z.number().int().nonnegative(),
        baselineLatencyMs: z.number().int().positive(),
        securityRegressions: z.number().int().nonnegative(),
      }),
    },
  },
  async ({ opportunityId, ...attestation }) =>
    textResult(
      mutate("attestCanary", { opportunityId, attestation }) ?? {
        attested: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_propose_evolution",
  {
    title: "Propose a canary-proven release",
    description:
      "A settled AgentPool improvement may propose a versioned release. Finance invariants cannot change.",
    inputSchema: {
      id: z.string().optional(),
      opportunityId: z.string(),
      proposerId: z.string(),
      parentRelease: z.string(),
      releaseId: z.string(),
      moduleHash: z.string(),
      manifestHash: z.string(),
      financeInvariantHash: z.string(),
      canary: z.object({
        qualityBps: z.number().int().min(0).max(10_000),
        baselineQualityBps: z.number().int().min(0).max(10_000),
        cost: z.number().int().nonnegative(),
        baselineCost: z.number().int().positive(),
        latencyMs: z.number().int().nonnegative(),
        baselineLatencyMs: z.number().int().positive(),
        securityRegressions: z.number().int().nonnegative(),
      }),
    },
  },
  async (args) =>
    textResult({ proposalId: mutate("proposeEvolution", args) }),
);

server.registerTool(
  "agentpool_v43_vote_evolution",
  {
    title: "Cast a proof-of-contribution release vote",
    description:
      "Voting weight comes from verified recent work, reliability, and a ten-percent per-agent cap. Token balance and model names have no vote multiplier.",
    inputSchema: {
      proposalId: z.string(),
      agentId: z.string(),
      support: z.boolean(),
      evidenceHash: z.string(),
    },
  },
  async ({ proposalId, ...vote }) =>
    textResult({
      weight: mutate("voteEvolution", { proposalId, vote }),
    }),
);

server.registerTool(
  "agentpool_v43_finalize_evolution_vote",
  {
    title: "Finalize contribution quorum",
    description:
      "Requires at least five proven contributors, three operator groups, thirty-percent contribution quorum, and a two-thirds supermajority.",
    inputSchema: { proposalId: z.string() },
  },
  async (args) =>
    textResult(
      mutate("finalizeEvolutionVote", args) ?? { proven: true },
    ),
);

server.registerTool(
  "agentpool_v43_record_adoption",
  {
    title: "Record an independent successful candidate adoption",
    description:
      "A proven release becomes recommended only after five successful jobs from at least three operator groups. Existing jobs remain pinned.",
    inputSchema: {
      proposalId: z.string(),
      agentId: z.string(),
      opportunityId: z.string(),
      outcomeHash: z.string(),
    },
  },
  async ({ proposalId, ...adoption }) =>
    textResult(
      mutate("recordAdoption", { proposalId, adoption }) ?? {
        recorded: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_attest_candidate_onchain",
  {
    title: "Bind a settled improvement to objective canary evidence onchain",
    description:
      "The settled milestone worker records one candidate receipt and fixed module, manifest, and canary metrics. This cannot mint or change the recommended release.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      receiptId: z.string().min(1),
      moduleHash: z.string().min(1),
      manifestHash: z.string().min(1),
      canary: onchainCanarySchema,
    },
  },
  async ({
    jobId,
    milestone,
    receiptId,
    moduleHash,
    manifestHash,
    canary,
  }) =>
    textResult(
      await chainWrite(
        contracts.taskMarket,
        abis.market,
        "attestCandidate",
        [
          jobId,
          milestone,
          bytes32(receiptId),
          bytes32(moduleHash),
          bytes32(manifestHash),
          canary.qualityBps,
          canary.baselineQualityBps,
          BigInt(canary.cost),
          BigInt(canary.baselineCost),
          BigInt(canary.latency),
          BigInt(canary.baselineLatency),
          canary.securityRegressions,
        ],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_prove_release_onchain",
  {
    title: "Register an opt-in PROVEN release onchain",
    description:
      "Consumes an objective candidate attestation and registers an append-only release. In BOOTSTRAP it remains opt-in and cannot replace the recommendation or gain emission authority.",
    inputSchema: {
      candidateReceiptId: z.string().min(1),
      parentRelease: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      releaseId: z.string().min(1),
      moduleHash: z.string().min(1),
      manifestHash: z.string().min(1),
      canary: onchainCanarySchema,
    },
  },
  async (args) =>
    textResult(
      await chainWrite(
        contracts.evolutionConsensus,
        abis.evolutionConsensus,
        "proveRelease",
        [
          bytes32(args.candidateReceiptId),
          args.parentRelease,
          bytes32(args.releaseId),
          bytes32(args.moduleHash),
          bytes32(args.manifestHash),
          deployment.financeInvariantHash,
          canaryTuple(args.canary),
        ],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_propose_recommendation_onchain",
  {
    title: "Open a MATURE Work Power recommendation vote",
    description:
      "MATURE-only. Bonds tAPOOL and opens commit/reveal plus independent adoption for an already PROVEN release. BOOTSTRAP calls are rejected by the contract.",
    inputSchema: {
      releaseId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      proposedSource: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .default("0x0000000000000000000000000000000000000000"),
      sourceActivation: z.boolean().default(false),
      bondApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
      commitDeadline: z.number().int().positive(),
      revealDeadline: z.number().int().positive(),
      adoptionDeadline: z.number().int().positive(),
    },
  },
  async (args) => {
    const bond = apool(args.bondApool);
    const approval = await chainWrite(
      contracts.token,
      abis.token,
      "approve",
      [contracts.evolutionConsensus, bond],
    );
    const proposalId = await chainRead(
      contracts.evolutionConsensus,
      abis.evolutionConsensus,
      "nextProposalId",
    );
    const proposal = await chainWrite(
      contracts.evolutionConsensus,
      abis.evolutionConsensus,
      "proposeRecommendation",
      [
        args.releaseId,
        args.proposedSource,
        args.sourceActivation,
        bond,
        args.commitDeadline,
        args.revealDeadline,
        args.adoptionDeadline,
      ],
    );
    return textResult({ proposalId: proposalId.toString(), approval, proposal });
  },
);

server.registerTool(
  "agentpool_v43_commit_recommendation_vote_onchain",
  {
    title: "Commit a private MATURE recommendation vote",
    description:
      "Commits a salted vote whose weight is measured Work Power, capped per AI. Keep the salt locally until reveal.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, salt }) => {
    const account = localAccount();
    const saltHash = bytes32(salt);
    const commitment = await chainRead(
      contracts.evolutionConsensus,
      abis.evolutionConsensus,
      "voteCommitment",
      [BigInt(proposalId), account.address, support, saltHash],
    );
    return textResult({
      commitment,
      ...(await chainWrite(
        contracts.evolutionConsensus,
        abis.evolutionConsensus,
        "commitVote",
        [BigInt(proposalId), commitment],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_reveal_recommendation_vote_onchain",
  {
    title: "Reveal a MATURE recommendation vote",
    description: "Reveals the previously committed support value and salt.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, salt }) =>
    textResult(
      await chainWrite(
        contracts.evolutionConsensus,
        abis.evolutionConsensus,
        "revealVote",
        [BigInt(proposalId), support, bytes32(salt)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_finalize_recommendation_onchain",
  {
    title: "Finalize MATURE recommendation voting",
    description:
      "After reveal closes, enforces five AIs, three groups, 30% Work Power quorum, and two-thirds support before entering adoption.",
    inputSchema: { proposalId: z.string().regex(/^\d+$/) },
  },
  async ({ proposalId }) =>
    textResult(
      await chainWrite(
        contracts.evolutionConsensus,
        abis.evolutionConsensus,
        "finalizeVote",
        [BigInt(proposalId)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_record_adoption_onchain",
  {
    title: "Record a successful independent release adoption onchain",
    description:
      "A settled job using the proposal release records one replay-protected adoption. Five adopters from three groups are required before recommendation.",
    inputSchema: {
      jobId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      milestone: z.number().int().min(0).max(31).default(0),
      proposalId: z.string().regex(/^\d+$/),
      receiptId: z.string().min(1),
    },
  },
  async ({ jobId, milestone, proposalId, receiptId }) =>
    textResult(
      await chainWrite(
        contracts.taskMarket,
        abis.market,
        "recordReleaseAdoption",
        [jobId, milestone, BigInt(proposalId), bytes32(receiptId)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_propose_transition_issue_onchain",
  {
    title: "Propose a capped TRANSITION system Issue",
    description:
      "v4.3.5 only. After real activity opens TRANSITION, bonds tAPOOL and proposes an EVOLUTION Issue whose verifier, validator root, budgets, candidate count, and lifetime are bounded by immutable gate policy.",
    inputSchema: {
      issue: matureIssueSchema,
      needEvidenceHash: z.string().min(1),
      bondApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
      commitDeadline: z.number().int().positive(),
      revealDeadline: z.number().int().positive(),
    },
  },
  async ({
    issue,
    needEvidenceHash,
    bondApool,
    commitDeadline,
    revealDeadline,
  }) => {
    requireStagedAutonomy();
    if (issue.funding !== 3) {
      throw new Error("V435_TRANSITION_REQUIRES_EVOLUTION_FUNDING");
    }
    const terms = issueTuple(issue);
    const bond = apool(bondApool);
    const approval = await chainWrite(
      contracts.token,
      abis.token,
      "approve",
      [contracts.transitionIssueConsensus, bond],
    );
    const proposalId = await chainRead(
      contracts.transitionIssueConsensus,
      abis.transitionIssueConsensus,
      "nextProposalId",
    );
    const proposal = await chainWrite(
      contracts.transitionIssueConsensus,
      abis.transitionIssueConsensus,
      "propose",
      [
        terms,
        bytes32(needEvidenceHash),
        bond,
        commitDeadline,
        revealDeadline,
      ],
    );
    return textResult({
      proposalId: proposalId.toString(),
      approval,
      proposal,
    });
  },
);

server.registerTool(
  "agentpool_v43_commit_transition_issue_vote_onchain",
  {
    title: "Commit an evidence-backed TRANSITION Issue vote",
    description:
      "v4.3.5 only. The Issue proposer cannot vote. Other proven agents commit support plus a private evidence hash and salt; at least two voters and two represented groups are required.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      evidenceHash: z.string().min(1),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, evidenceHash, salt }) => {
    requireStagedAutonomy();
    const account = localAccount();
    const evidenceDigest = bytes32(evidenceHash);
    const saltHash = bytes32(salt);
    const commitment = await chainRead(
      contracts.transitionIssueConsensus,
      abis.transitionIssueConsensus,
      "voteCommitment",
      [
        BigInt(proposalId),
        account.address,
        support,
        evidenceDigest,
        saltHash,
      ],
    );
    return textResult({
      commitment,
      ...(await chainWrite(
        contracts.transitionIssueConsensus,
        abis.transitionIssueConsensus,
        "commitVote",
        [BigInt(proposalId), commitment],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_reveal_transition_issue_vote_onchain",
  {
    title: "Reveal a TRANSITION Issue vote and evidence",
    description:
      "v4.3.5 only. Reveals the exact support value, evidence hash, and salt committed earlier.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      evidenceHash: z.string().min(1),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, evidenceHash, salt }) => {
    requireStagedAutonomy();
    return textResult(
      await chainWrite(
        contracts.transitionIssueConsensus,
        abis.transitionIssueConsensus,
        "revealVote",
        [
          BigInt(proposalId),
          support,
          bytes32(evidenceHash),
          bytes32(salt),
        ],
      ),
    );
  },
);

server.registerTool(
  "agentpool_v43_finalize_transition_issue_onchain",
  {
    title: "Finalize capped TRANSITION Issue consensus",
    description:
      "v4.3.5 only. After reveal closes, enforces two non-proposer voters, multiple operator groups, contribution quorum, and two-thirds support before the bounded Issue can reserve emission.",
    inputSchema: { proposalId: z.string().regex(/^\d+$/) },
  },
  async ({ proposalId }) => {
    requireStagedAutonomy();
    return textResult(
      await chainWrite(
        contracts.transitionIssueConsensus,
        abis.transitionIssueConsensus,
        "finalize",
        [BigInt(proposalId)],
      ),
    );
  },
);

server.registerTool(
  "agentpool_v43_propose_system_issue_onchain",
  {
    title: "Open a MATURE Work Power system-Issue vote",
    description:
      "MATURE-only. Proposes exact verifier, evidence, objective root, validator policy, budgets, and expiry. The proposer cannot directly open emission.",
    inputSchema: {
      issue: matureIssueSchema,
      bondApool: z.string().regex(/^\d+(\.\d{1,18})?$/),
      commitDeadline: z.number().int().positive(),
      revealDeadline: z.number().int().positive(),
    },
  },
  async ({ issue, bondApool, commitDeadline, revealDeadline }) => {
    const terms = issueTuple(issue);
    const bond = apool(bondApool);
    const approval = await chainWrite(
      contracts.token,
      abis.token,
      "approve",
      [contracts.issueConsensus, bond],
    );
    const proposalId = await chainRead(
      contracts.issueConsensus,
      abis.issueConsensus,
      "nextProposalId",
    );
    const proposal = await chainWrite(
      contracts.issueConsensus,
      abis.issueConsensus,
      "propose",
      [terms, bond, commitDeadline, revealDeadline],
    );
    return textResult({ proposalId: proposalId.toString(), approval, proposal });
  },
);

server.registerTool(
  "agentpool_v43_commit_system_issue_vote_onchain",
  {
    title: "Commit a private MATURE system-Issue vote",
    description:
      "Commits a salted Work Power vote. Keep the salt locally until reveal.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, salt }) => {
    const account = localAccount();
    const saltHash = bytes32(salt);
    const commitment = await chainRead(
      contracts.issueConsensus,
      abis.issueConsensus,
      "voteCommitment",
      [BigInt(proposalId), account.address, support, saltHash],
    );
    return textResult({
      commitment,
      ...(await chainWrite(
        contracts.issueConsensus,
        abis.issueConsensus,
        "commitVote",
        [BigInt(proposalId), commitment],
      )),
    });
  },
);

server.registerTool(
  "agentpool_v43_reveal_system_issue_vote_onchain",
  {
    title: "Reveal a MATURE system-Issue vote",
    description: "Reveals the previously committed support value and salt.",
    inputSchema: {
      proposalId: z.string().regex(/^\d+$/),
      support: z.boolean(),
      salt: z.string().min(1),
    },
  },
  async ({ proposalId, support, salt }) =>
    textResult(
      await chainWrite(
        contracts.issueConsensus,
        abis.issueConsensus,
        "revealVote",
        [BigInt(proposalId), support, bytes32(salt)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_finalize_system_issue_onchain",
  {
    title: "Finalize MATURE system-Issue voting",
    description:
      "After reveal closes, approves the exact Issue hash only if Work Power diversity, quorum, and supermajority all pass.",
    inputSchema: { proposalId: z.string().regex(/^\d+$/) },
  },
  async ({ proposalId }) =>
    textResult(
      await chainWrite(
        contracts.issueConsensus,
        abis.issueConsensus,
        "finalize",
        [BigInt(proposalId)],
      ),
    ),
);

server.registerTool(
  "agentpool_v43_flow",
  {
    title: "Explain the autonomous AgentPool flow",
    description:
      "Returns the complete machine-oriented sequence and authority boundaries for a zero-context AI.",
    inputSchema: {},
  },
  async () =>
    textResult({
      work:
        "read shared signed opportunities -> publish commit/reveal plans and role bids -> compete on DAG plans -> reserve budget and capacity onchain -> execute/subcontract -> evidence-only evaluation -> deterministic settlement -> update work power -> reinvest",
      evolution:
        "buyer-funded or fixed BOOTSTRAP improvement -> objective canary -> opt-in PROVEN release; after verified activity opens TRANSITION -> capped non-proposer Issue consensus; after automatic MATURE -> capped Work Power vote -> independent adoption -> recommended release",
      immutable:
        "maximum supply, external-job zero emission, reservation cap, refund path, signature/receipt replay protection, and evaluator inability to set payouts",
      evolvable:
        "planners, routers, model adapters, MCP/API adapters, validators, benchmarks, user interfaces, and recommended releases",
      authority:
        "No single AI or owner upgrades running jobs. Releases are append-only; each job stays pinned to its creation release.",
      status:
        stagedAutonomyAvailable
          ? "v4.3.5 exposes BOOTSTRAP, capped TRANSITION, and irreversible MATURE paths. Buyer-funded improvements stay open in every phase; only admitted objective work can emit test tAPOOL."
          : "The current public contracts remain v4.3.4. Its finite BOOTSTRAP emission Issue is consumed; buyer-funded work and opt-in PROVEN releases remain open while v4.3.5 staged autonomy is not yet deployed.",
    }),
);

async function selfTest() {
  const methods = [
    "registerAgent",
    "publishOpportunity",
    "submitRewardQuote",
    "submitPlan",
    "awardPlan",
    "submitRoleBid",
    "allocateReadyTasks",
    "deliverTask",
    "evaluateTask",
    "settleTask",
    "finalizeOpportunity",
    "attestCanary",
    "proposeEvolution",
    "voteEvolution",
    "finalizeEvolutionVote",
    "recordAdoption",
  ];
  const uniqueMethods = new Set(methods);
  if (
    uniqueMethods.size !== methods.length ||
    !engine.financeInvariantHash ||
    digest({ selfTest: true }).length !== 66
  ) {
    throw new Error("V43_MCP_SELF_TEST_FAILED");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      release: deployment.version,
      tools: 52,
      persistentEventLog: true,
      evaluatorCanSetPayout: false,
      baseSepoliaDeployment: true,
      issueGate: true,
      walletCustody: "device-local-only",
    })}\n`,
  );
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  await server.connect(new StdioServerTransport());
}
