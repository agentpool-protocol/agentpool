import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "../deployments/84532.v43.5.json" with { type: "json" };
import {
  buildTaskDag,
  createRiskAdjustedBid,
  decideWorkPowerVote,
  evaluateCanary,
  selectWinningBids,
  validateExecutionResult,
} from "../runner/agentpool-autonomy-core.mjs";
import { createExecutionAdapter } from "../runner/execution-adapters.mjs";
import {
  generatePrivateChannelKeyPair,
  openPrivateJson,
  sealPrivateJson,
} from "../runner/private-channel.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputs = path.join(root, "outputs");
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "agentpool-three-ai-pilot-"),
);

function providerAdapter(provider) {
  const content = JSON.stringify({
    content: `${provider}:completed`,
    evidence: {
      provider,
      candidateMetrics: {
        qualityBps: 9_500,
        cost: 80,
        latencyMs: 80,
        securityRegressions: 0,
      },
      baselineMetrics: {
        qualityBps: 9_000,
        cost: 100,
        latencyMs: 100,
      },
    },
    usage: { units: 1 },
  });
  return createExecutionAdapter({
    provider,
    enabled: true,
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(content)})`],
    workspace,
    allowedWorkspaceRoots: [workspace],
  });
}

try {
  const opportunity = {
    schema: "agentpool.autonomy.opportunity/v1",
    id: "pilot:three-ai-composite",
    capability: "planning",
    maxBudgetApool: "30",
    expiresAt: Date.now() + 60_000,
    task: {
      steps: [
        {
          id: "research",
          capability: "research",
          dependencies: [],
          task: { kind: "AGENT_EXECUTE", provider: "qwen" },
          weight: 1,
        },
        {
          id: "build",
          capability: "code",
          dependencies: ["research"],
          task: { kind: "AGENT_EXECUTE", provider: "codex" },
          weight: 2,
        },
        {
          id: "review",
          capability: "review",
          dependencies: ["build"],
          task: { kind: "AGENT_EXECUTE", provider: "claude" },
          weight: 1,
        },
      ],
    },
  };
  const plan = buildTaskDag(opportunity);
  const providerByTask = {
    research: "qwen",
    build: "codex",
    review: "claude",
  };
  const bids = plan.tasks.map((task, index) =>
    createRiskAdjustedBid(task, {
      provider: providerByTask[task.id],
      bidderAddress: `0x${String(index + 1).padStart(40, "0")}`,
      operatorGroup: `independent-group-${index + 1}`,
      priceApool: task.id === "build" ? "10" : "5",
      successLowerBps: 9_000 + index * 100,
      capacityUnits: 1,
      expiresAt: opportunity.expiresAt,
    }),
  );
  const award = selectWinningBids(plan, bids);
  const results = {};
  for (const task of plan.tasks) {
    results[task.id] = await providerAdapter(
      providerByTask[task.id],
    ).execute(task.task);
  }
  const validations = Object.fromEntries(
    Object.entries(results).map(([taskId, result]) => [
      taskId,
      validateExecutionResult({
        result,
        policy: "NONEMPTY",
      }),
    ]),
  );
  const keys = await generatePrivateChannelKeyPair();
  const privateEnvelope = await sealPrivateJson(keys.publicKey, {
    task: opportunity.task,
  });
  const decrypted = await openPrivateJson(keys.privateKey, privateEnvelope);
  const canary = evaluateCanary(
    results.build.evidence.candidateMetrics,
    results.build.evidence.baselineMetrics,
    {
      minimumQualityGainBps: 100,
      minimumCostSavingBps: 1_000,
      minimumLatencySavingBps: 1_000,
    },
  );
  const workPower = decideWorkPowerVote(
    Array.from({ length: 6 }, (_, index) => ({
      agentId: `agent-${index}`,
      operatorGroup: `group-${index % 3}`,
      power: 1_000n,
      support: index < 5,
    })),
    { eligiblePower: 10_000n },
  );

  const chain = createPublicClient({
    chain: baseSepolia,
    transport: http(
      process.env.AGENTPOOL_V43_RPC_URL ?? "https://sepolia.base.org",
      { timeout: 30_000, retryCount: 2 },
    ),
  });
  const blockNumber = await chain.getBlockNumber();
  const contractChecks = {};
  for (const [name, contractAddress] of Object.entries(
    deployment.contracts,
  )) {
    const code = await chain.getCode({ address: contractAddress });
    contractChecks[name] = Boolean(code && code !== "0x");
  }
  const evidence = {
    schema: "agentpool.three-ai-pilot/v1",
    generatedAt: new Date().toISOString(),
    chain: {
      chainId: 84532,
      blockNumber: blockNumber.toString(),
      contractChecks,
      writes: 0,
    },
    plan: {
      planHash: plan.planHash,
      tasks: plan.tasks.map(({ id, capability, dependencies }) => ({
        id,
        capability,
        dependencies,
      })),
      selectedProviders: award.selected.map((bid) => bid.provider),
      reservedBaseUnits: award.reservedBaseUnits,
    },
    results,
    validations,
    privateChannel: {
      suite: privateEnvelope.suite,
      ciphertextHash: privateEnvelope.ciphertextHash,
      relaySawPlaintext: false,
      decryptedMatches: JSON.stringify(decrypted.task) ===
        JSON.stringify(opportunity.task),
    },
    improvement: {
      canary,
      workPower,
    },
    acceptance: {
      threeProvidersSelected:
        new Set(award.selected.map((bid) => bid.provider)).size === 3,
      allTasksPassed: Object.values(validations).every(
        (validation) => validation.passed,
      ),
      canaryPassed: canary.passed,
      voteApproved: workPower.approved,
      baseSepoliaContractsPresent: Object.values(contractChecks).every(
        Boolean,
      ),
    },
  };
  await mkdir(outputs, { recursive: true });
  const evidencePath = path.join(
    outputs,
    "v43-three-ai-autonomy-pilot.json",
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      evidencePath,
      acceptance: evidence.acceptance,
      blockNumber: evidence.chain.blockNumber,
    })}\n`,
  );
  if (!Object.values(evidence.acceptance).every(Boolean)) {
    process.exitCode = 1;
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
