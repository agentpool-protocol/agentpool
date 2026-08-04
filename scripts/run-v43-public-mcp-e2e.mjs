import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  fs.readFileSync(
    path.join(root, "deployments", "84532.v43.5.json"),
    "utf8",
  ),
);
const marketAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV432TaskMarket.json"),
    "utf8",
  ),
).abi;
const tokenAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43Token.json"),
    "utf8",
  ),
).abi;
const registryAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43ReleaseRegistry.json"),
    "utf8",
  ),
).abi;
const capacityAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43CapacityRegistry.json"),
    "utf8",
  ),
).abi;
const escrowAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43UserEscrowKernel.json"),
    "utf8",
  ),
).abi;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

if (requireEnv("AGENTPOOL_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("BASE_SEPOLIA_ONLY");
}

const keys = {
  buyer: requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY"),
  worker: requireEnv("TESTNET_AUTHOR_PRIVATE_KEY"),
  validator: requireEnv("TESTNET_VALIDATOR_1_PRIVATE_KEY"),
  resolver:
    process.env.V41_DEPLOYER_PRIVATE_KEY?.trim() ||
    requireEnv("DEPLOYER_PRIVATE_KEY"),
};
const accounts = Object.fromEntries(
  Object.entries(keys).map(([role, privateKey]) => [
    role,
    privateKeyToAccount(privateKey),
  ]),
);
const gasMinimums = {
  buyer: 20_000_000_000_000n,
  worker: 15_000_000_000_000n,
  resolver: 8_000_000_000_000n,
};
const gasBalances = Object.fromEntries(
  await Promise.all(
    Object.entries(gasMinimums).map(async ([role]) => [
      role,
      await publicClient.getBalance({ address: accounts[role].address }),
    ]),
  ),
);
const gasDeficits = Object.entries(gasMinimums)
  .filter(([role, minimum]) => gasBalances[role] < minimum)
  .map(([role, minimum]) => ({
    role,
    address: accounts[role].address,
    balanceTestEth: formatEther(gasBalances[role]),
    minimumTestEth: formatEther(minimum),
  }));
if (gasDeficits.length > 0) {
  throw new Error(`PUBLIC_MCP_E2E_TEST_GAS_REQUIRED:${JSON.stringify(gasDeficits)}`);
}
const runId = `public-mcp-${Date.now().toString(36)}`;
const outputPath = path.join(
  root,
  "outputs",
  "v43.5-public-mcp-onchain-e2e.json",
);
const publicEvidencePath = path.join(
  root,
  "deployments",
  "84532.v43.5.mcp-e2e.json",
);
const temporaryHomes = [];
const clients = [];
const transactions = [];
const expectedRejections = [];

function parseTool(result, toolName) {
  const content = result.content?.[0];
  const message =
    content?.type === "text" ? content.text : JSON.stringify(result.content);
  if (result.isError) throw new Error(`${toolName}:${message}`);
  assert.equal(content?.type, "text", `${toolName} returned no text`);
  return JSON.parse(content.text);
}

async function call(role, toolName, args = {}) {
  const result = await clientsByRole[role].callTool({
    name: toolName,
    arguments: args,
  });
  const parsed = parseTool(result, toolName);
  collectTransactions(role, toolName, parsed);
  return parsed;
}

async function expectToolError(role, toolName, args, code) {
  const result = await clientsByRole[role].callTool({
    name: toolName,
    arguments: args,
  });
  const message = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, `${toolName} unexpectedly succeeded`);
  assert.match(message, new RegExp(code, "i"));
  expectedRejections.push({ role, toolName, code });
}

function collectTransactions(role, toolName, value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.transactionHash === "string") {
    transactions.push({
      role,
      toolName,
      transactionHash: value.transactionHash,
      blockNumber: value.blockNumber,
      gasUsed: value.gasUsed,
    });
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      collectTransactions(role, toolName, nested);
    }
  }
}

async function openClient(role, privateKey) {
  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), `agentpool-v43-${role}-`),
  );
  temporaryHomes.push(tempHome);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "public", "agentpool-mcp.mjs")],
    env: {
      ...process.env,
      AGENTPOOL_V43_HOME: tempHome,
      AGENTPOOL_V43_PRIVATE_KEY: privateKey,
      AGENTPOOL_V43_RPC_URL: rpcUrl,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: `agentpool-${role}-public-e2e`,
    version: "1.0.0",
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function read(address, abi, functionName, args = []) {
  return publicClient.readContract({ address, abi, functionName, args });
}

function milestone({
  label,
  capability,
  workerAmount,
  validatorAmount,
  keeperAmount,
  dependencies,
  deadline,
}) {
  return {
    worker: accounts.worker.address,
    validatorRecipient: accounts.validator.address,
    capability,
    specification: `${runId}-${label}-specification`,
    expectedDelivery: `${runId}-${label}-delivery`,
    proofText: `${runId}-${label}-proof`,
    workerAmountApool: workerAmount,
    validatorAmountApool: validatorAmount,
    keeperAmountApool: keeperAmount,
    deadline,
    capacityUnits: 1,
    minimumReveals: 0,
    passScoreBps: 0,
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
    dependencies,
  };
}

async function ensureWorkerCapacity(capability, deadline) {
  const offer = await read(
    deployment.contracts.capacityRegistry,
    capacityAbi,
    "offers",
    [accounts.worker.address, keccak256(toBytes(capability))],
  );
  if (
    Number(offer[0]) - Number(offer[1]) >= 3 &&
    Number(offer[2]) >= deadline
  ) {
    return { reused: true };
  }
  return call("worker", "agentpool_v43_publish_capacity_onchain", {
    capability,
    capacity: 8,
    expiresAt: deadline + 3_600,
    runtime: `${runId}-worker-runtime`,
  });
}

const clientsByRole = {};
try {
  for (const [role, privateKey] of Object.entries(keys)) {
    clientsByRole[role] = await openClient(role, privateKey);
  }

  const discovered = await clientsByRole.buyer.listTools();
  assert.equal(discovered.tools.length, 48);
  for (const required of [
    "agentpool_v43_create_external_job",
    "agentpool_v43_create_external_dag_onchain",
    "agentpool_v43_hold_budget_onchain",
    "agentpool_v43_replan_external_dag_onchain",
    "agentpool_v43_attest_candidate_onchain",
    "agentpool_v43_prove_release_onchain",
  ]) {
    assert.ok(discovered.tools.some((tool) => tool.name === required));
  }

  const chainStatus = await call("buyer", "agentpool_v43_chain_status");
  assert.equal(chainStatus.chainId, 84532);
  assert.equal(chainStatus.release, "4.3.5-staged-autonomy-alpha");
  assert.equal(chainStatus.phase, "BOOTSTRAP");

  const supplyBefore = await read(
    deployment.contracts.token,
    tokenAbi,
    "totalSupply",
  );
  const recommendedBefore = await read(
    deployment.contracts.releaseRegistry,
    registryAbi,
    "recommendedRelease",
  );
  const deadline = Math.floor(Date.now() / 1000) + 7_200;

  await ensureWorkerCapacity("agentpool-system-improvement", deadline);
  await ensureWorkerCapacity("external-worker-pilot", deadline);

  const improvement = {
    plan: `${runId}-improvement-plan`,
    worker: accounts.worker.address,
    validatorRecipient: accounts.validator.address,
    capability: "agentpool-system-improvement",
    specification: `${runId}-improvement-specification`,
    expectedDelivery: `${runId}-improvement-delivery`,
    proofText: `${runId}-improvement-proof`,
    workerAmountApool: "6",
    validatorAmountApool: "1",
    keeperAmountApool: "1",
    deadline,
    capacityUnits: 1,
    minimumReveals: 0,
    passScoreBps: 0,
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
  };
  const improvementCreated = await call(
    "buyer",
    "agentpool_v43_create_external_job",
    improvement,
  );
  await call("worker", "agentpool_v43_accept_milestone_onchain", {
    jobId: improvementCreated.jobId,
    milestone: 0,
  });
  await call("worker", "agentpool_v43_deliver_milestone_onchain", {
    jobId: improvementCreated.jobId,
    milestone: 0,
    delivery: improvement.expectedDelivery,
  });
  await call("resolver", "agentpool_v43_resolve_milestone_onchain", {
    jobId: improvementCreated.jobId,
    milestone: 0,
    proofText: improvement.proofText,
    recipients: [accounts.worker.address, accounts.validator.address],
    amountsApool: [
      improvement.workerAmountApool,
      improvement.validatorAmountApool,
    ],
  });

  const canary = {
    qualityBps: 9_700,
    baselineQualityBps: 9_500,
    cost: 90,
    baselineCost: 100,
    latency: 100,
    baselineLatency: 100,
    securityRegressions: 0,
  };
  const receiptLabel = `${runId}-candidate-receipt`;
  const moduleLabel = `${runId}-candidate-module`;
  const manifestLabel = `${runId}-candidate-manifest`;
  const releaseLabel = `${runId}-proven-release`;
  const provenRelease = keccak256(toBytes(releaseLabel));
  await call("worker", "agentpool_v43_attest_candidate_onchain", {
    jobId: improvementCreated.jobId,
    milestone: 0,
    receiptId: receiptLabel,
    moduleHash: moduleLabel,
    manifestHash: manifestLabel,
    canary,
  });
  await call("worker", "agentpool_v43_prove_release_onchain", {
    candidateReceiptId: receiptLabel,
    parentRelease: recommendedBefore,
    releaseId: releaseLabel,
    moduleHash: moduleLabel,
    manifestHash: manifestLabel,
    canary,
  });
  assert.equal(
    await read(
      deployment.contracts.releaseRegistry,
      registryAbi,
      "isUsable",
      [provenRelease],
    ),
    true,
  );
  assert.equal(
    await read(
      deployment.contracts.releaseRegistry,
      registryAbi,
      "recommendedRelease",
    ),
    recommendedBefore,
  );
  const pinnedImprovement = await read(
    deployment.contracts.taskMarket,
    marketAbi,
    "jobs",
    [improvementCreated.jobId],
  );
  assert.equal(pinnedImprovement[4], recommendedBefore);

  const dagOriginal = [
    milestone({
      label: "dag-0",
      capability: "external-worker-pilot",
      workerAmount: "3",
      validatorAmount: "0.5",
      keeperAmount: "0.5",
      dependencies: [],
      deadline,
    }),
    milestone({
      label: "dag-1",
      capability: "external-worker-pilot",
      workerAmount: "3",
      validatorAmount: "0.5",
      keeperAmount: "0.5",
      dependencies: [],
      deadline,
    }),
    milestone({
      label: "dag-2-original",
      capability: "external-worker-pilot",
      workerAmount: "4",
      validatorAmount: "0.5",
      keeperAmount: "0.5",
      dependencies: [0, 1],
      deadline,
    }),
  ];
  const dagCreated = await call(
    "buyer",
    "agentpool_v43_create_external_dag_onchain",
    {
      plan: `${runId}-dag-original-plan`,
      milestones: dagOriginal,
    },
  );
  assert.deepEqual(dagCreated.dependencyMasks, [0, 0, 3]);
  await expectToolError(
    "worker",
    "agentpool_v43_accept_milestone_onchain",
    { jobId: dagCreated.jobId, milestone: 2 },
    "InvalidState|execution reverted",
  );
  for (const index of [0, 1]) {
    await call("worker", "agentpool_v43_accept_milestone_onchain", {
      jobId: dagCreated.jobId,
      milestone: index,
    });
    await call("worker", "agentpool_v43_deliver_milestone_onchain", {
      jobId: dagCreated.jobId,
      milestone: index,
      delivery: dagOriginal[index].expectedDelivery,
    });
  }
  for (const index of [1, 0]) {
    await call("resolver", "agentpool_v43_resolve_milestone_onchain", {
      jobId: dagCreated.jobId,
      milestone: index,
      proofText: dagOriginal[index].proofText,
      recipients: [accounts.worker.address, accounts.validator.address],
      amountsApool: [
        dagOriginal[index].workerAmountApool,
        dagOriginal[index].validatorAmountApool,
      ],
    });
  }
  await call("buyer", "agentpool_v43_hold_budget_onchain", {
    jobId: dagCreated.jobId,
    reason: `${runId}-lower-cost-replan`,
  });

  const dagReplanned = [
    dagOriginal[0],
    dagOriginal[1],
    milestone({
      label: "dag-2-replanned",
      capability: "external-worker-pilot",
      workerAmount: "2",
      validatorAmount: "0.5",
      keeperAmount: "0.5",
      dependencies: [0, 1],
      deadline,
    }),
  ];
  const mutatedSettled = structuredClone(dagReplanned);
  mutatedSettled[0].specification = `${runId}-illegal-settled-mutation`;
  await expectToolError(
    "buyer",
    "agentpool_v43_replan_external_dag_onchain",
    {
      jobId: dagCreated.jobId,
      plan: `${runId}-illegal-replan`,
      milestones: mutatedSettled,
    },
    "InvalidTerms|execution reverted",
  );
  await call("buyer", "agentpool_v43_replan_external_dag_onchain", {
    jobId: dagCreated.jobId,
    plan: `${runId}-valid-replan`,
    milestones: dagReplanned,
  });
  await call("worker", "agentpool_v43_accept_milestone_onchain", {
    jobId: dagCreated.jobId,
    milestone: 2,
  });
  await call("worker", "agentpool_v43_deliver_milestone_onchain", {
    jobId: dagCreated.jobId,
    milestone: 2,
    delivery: dagReplanned[2].expectedDelivery,
  });
  await expectToolError(
    "resolver",
    "agentpool_v43_resolve_milestone_onchain",
    {
      jobId: dagCreated.jobId,
      milestone: 2,
      proofText: dagReplanned[2].proofText,
      recipients: [accounts.worker.address, accounts.validator.address],
      amountsApool: ["2.1", "0.5"],
    },
    "InvalidState|execution reverted",
  );
  await call("resolver", "agentpool_v43_resolve_milestone_onchain", {
    jobId: dagCreated.jobId,
    milestone: 2,
    proofText: dagReplanned[2].proofText,
    recipients: [accounts.worker.address, accounts.validator.address],
    amountsApool: [
      dagReplanned[2].workerAmountApool,
      dagReplanned[2].validatorAmountApool,
    ],
  });
  await expectToolError(
    "resolver",
    "agentpool_v43_resolve_milestone_onchain",
    {
      jobId: dagCreated.jobId,
      milestone: 2,
      proofText: dagReplanned[2].proofText,
      recipients: [accounts.worker.address, accounts.validator.address],
      amountsApool: [
        dagReplanned[2].workerAmountApool,
        dagReplanned[2].validatorAmountApool,
      ],
    },
    "InvalidState|execution reverted",
  );

  const refundBalanceBefore = await read(
    deployment.contracts.token,
    tokenAbi,
    "balanceOf",
    [accounts.buyer.address],
  );
  const refundJob = {
    releaseId: provenRelease,
    plan: `${runId}-refund-plan`,
    worker: accounts.worker.address,
    validatorRecipient: accounts.validator.address,
    capability: "external-worker-pilot",
    specification: `${runId}-refund-specification`,
    expectedDelivery: `${runId}-refund-delivery`,
    proofText: `${runId}-correct-refund-proof`,
    workerAmountApool: "1",
    validatorAmountApool: "0.5",
    keeperAmountApool: "0.5",
    deadline,
    capacityUnits: 1,
    minimumReveals: 0,
    passScoreBps: 0,
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
  };
  const refundCreated = await call(
    "buyer",
    "agentpool_v43_create_external_job",
    refundJob,
  );
  const pinnedOptIn = await read(
    deployment.contracts.taskMarket,
    marketAbi,
    "jobs",
    [refundCreated.jobId],
  );
  assert.equal(pinnedOptIn[4], provenRelease);
  await call("worker", "agentpool_v43_accept_milestone_onchain", {
    jobId: refundCreated.jobId,
    milestone: 0,
  });
  await call("worker", "agentpool_v43_deliver_milestone_onchain", {
    jobId: refundCreated.jobId,
    milestone: 0,
    delivery: refundJob.expectedDelivery,
  });
  await call("resolver", "agentpool_v43_resolve_milestone_onchain", {
    jobId: refundCreated.jobId,
    milestone: 0,
    proofText: `${runId}-wrong-refund-proof`,
    recipients: [accounts.worker.address, accounts.validator.address],
    amountsApool: [
      refundJob.workerAmountApool,
      refundJob.validatorAmountApool,
    ],
  });
  const rejectedJob = await read(
    deployment.contracts.taskMarket,
    marketAbi,
    "jobs",
    [refundCreated.jobId],
  );
  assert.equal(Number(rejectedJob[2]), 5);
  const refundBalanceAfter = await read(
    deployment.contracts.token,
    tokenAbi,
    "balanceOf",
    [accounts.buyer.address],
  );
  assert.equal(refundBalanceAfter, refundBalanceBefore);
  await expectToolError(
    "resolver",
    "agentpool_v43_resolve_milestone_onchain",
    {
      jobId: refundCreated.jobId,
      milestone: 0,
      proofText: refundJob.proofText,
      recipients: [accounts.worker.address, accounts.validator.address],
      amountsApool: [
        refundJob.workerAmountApool,
        refundJob.validatorAmountApool,
      ],
    },
    "InvalidState|execution reverted",
  );

  const dagJob = await read(
    deployment.contracts.taskMarket,
    marketAbi,
    "jobs",
    [dagCreated.jobId],
  );
  assert.equal(Number(dagJob[2]), 4);
  assert.equal(formatUnits(dagJob[6], 18), "13");
  assert.equal(formatUnits(dagJob[7], 18), "11");
  const dagEscrow = await read(
    deployment.contracts.userEscrow,
    escrowAbi,
    "deposits",
    [dagCreated.jobId],
  );
  assert.equal(dagEscrow[1] - dagEscrow[2], 2n * 10n ** 18n);
  assert.equal(dagEscrow[3], true);
  const supplyAfter = await read(
    deployment.contracts.token,
    tokenAbi,
    "totalSupply",
  );
  assert.equal(supplyAfter, supplyBefore);

  const evidence = {
    ok: true,
    release: "4.3.5-staged-autonomy-alpha",
    network: "Base Sepolia",
    chainId: 84532,
    testnetOnly: true,
    discoveredToolCount: discovered.tools.length,
    buyer: accounts.buyer.address,
    worker: accounts.worker.address,
    resolver: accounts.resolver.address,
    buyerFundedImprovement: {
      jobId: improvementCreated.jobId,
      budgetApool: improvementCreated.budgetApool,
      newEmissionApool: "0",
      candidateReceiptId: keccak256(toBytes(receiptLabel)),
      provenRelease,
      recommendedReleaseUnchanged: true,
      originalJobReleasePinned: true,
    },
    dependencyDag: {
      jobId: dagCreated.jobId,
      nodes: 3,
      dependencyMasks: dagCreated.dependencyMasks,
      independentLeavesSettledOutOfOrder: true,
      budgetApool: "13",
      paidApool: "11",
      refundedApool: "2",
      settledNodesCannotBeRewritten: true,
    },
    invalidWorkRefund: {
      jobId: refundCreated.jobId,
      selectedOptInRelease: provenRelease,
      state: "REJECTED",
      buyerRefundedApool: "2",
      newEmissionApool: "0",
    },
    expectedRejections,
    totalSupplyBeforeApool: formatUnits(supplyBefore, 18),
    totalSupplyAfterApool: formatUnits(supplyAfter, 18),
    transactionCount: transactions.length,
    transactions,
    privateKeysStoredOrExposed: false,
    completedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(
    publicEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: evidence.ok,
      evidencePath: outputPath,
      publicEvidencePath,
      transactionCount: evidence.transactionCount,
      provenRelease,
      dagJobId: dagCreated.jobId,
      refundJobId: refundCreated.jobId,
      supplyApool: evidence.totalSupplyAfterApool,
    })}\n`,
  );
} finally {
  for (const client of clients.reverse()) {
    await client.close().catch(() => {});
  }
  for (const tempHome of temporaryHomes) {
    const resolved = path.resolve(tempHome);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  }
}
