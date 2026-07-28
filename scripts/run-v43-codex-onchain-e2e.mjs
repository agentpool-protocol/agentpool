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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createExecutorRegistry } from "../runner/execution-adapters.mjs";
import {
  executeRunnerTaskWithAdapters,
  runValidatorCycle,
  sealRunnerResultForBuyer,
} from "../runner/agentpool-role-runner-core.mjs";
import {
  newRunnerState,
  parseMcpToolResult,
  runRunnerCycle,
} from "../runner/agentpool-runner-core.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deployment = JSON.parse(
  fs.readFileSync(
    path.join(root, "deployments", "84532.v43.5.json"),
    "utf8",
  ),
);
const tokenAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43Token.json"),
    "utf8",
  ),
).abi;
const marketAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV432TaskMarket.json"),
    "utf8",
  ),
).abi;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

if (required("AGENTPOOL_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("TESTNET_DISPOSABLE_WALLETS_REQUIRED");
}
const rpcUrl = required("AGENTPOOL_RPC_URL");
const keys = {
  buyer: required("TESTNET_OPERATIONS_PRIVATE_KEY"),
  worker: required("TESTNET_AUTHOR_PRIVATE_KEY"),
  validator: required("TESTNET_VALIDATOR_1_PRIVATE_KEY"),
};
const accounts = Object.fromEntries(
  Object.entries(keys).map(([role, privateKey]) => [
    role,
    privateKeyToAccount(privateKey),
  ]),
);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
assert.equal(await publicClient.getChainId(), 84532);

const gasMinimums = {
  buyer: 4_000_000_000_000n,
  worker: 5_000_000_000_000n,
  validator: 2_000_000_000_000n,
};
for (const [role, minimum] of Object.entries(gasMinimums)) {
  const balance = await publicClient.getBalance({
    address: accounts[role].address,
  });
  if (balance < minimum) {
    throw new Error(
      `CODEX_ONCHAIN_GAS_REQUIRED:${role}:${formatEther(balance)}`,
    );
  }
}

const temporaryHomes = [];
const clients = [];
async function openMcp(role) {
  const home = await mkdtemp(
    path.join(os.tmpdir(), `agentpool-codex-${role}-`),
  );
  temporaryHomes.push(home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "public", "agentpool-mcp.mjs")],
    env: {
      ...process.env,
      AGENTPOOL_V43_HOME: home,
      AGENTPOOL_V43_PRIVATE_KEY: keys[role],
      AGENTPOOL_V43_RPC_URL: rpcUrl,
      AGENTPOOL_V43_RELAY_URL:
        "https://agentpool-protocol.asfu.chatgpt.site",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: `agentpool-codex-${role}-e2e`,
    version: "1.0.0",
  });
  await client.connect(transport);
  clients.push(client);
  return {
    async call(name, args = {}) {
      return parseMcpToolResult(
        await client.callTool({ name, arguments: args }),
        name,
      );
    },
  };
}

async function balance(address) {
  return publicClient.readContract({
    address: deployment.contracts.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [address],
  });
}

const runId = `codex-${Date.now().toString(36)}`;
const expected = `AGENTPOOL_CODEX_PAID_${runId.toUpperCase()}`;
const capability = "mcp-json-data-code-low-risk";
const deadline = Math.floor(Date.now() / 1000) + 1_800;
const evidencePath = path.join(
  root,
  "deployments",
  "84532.v43.6.codex-e2e.json",
);
const outputPath = path.join(
  root,
  "outputs",
  "v43.6-codex-onchain-e2e.json",
);

try {
  const buyerMcp = await openMcp("buyer");
  const workerMcp = await openMcp("worker");
  const validatorMcpBase = await openMcp("validator");
  const validatorMcp = {
    async call(name, args = {}) {
      if (
        name === "agentpool_v43_shared_coordination" &&
        args.eventType === "RESULT_AVAILABLE"
      ) {
        return validatorMcpBase.call(name, {
          ...args,
          opportunityId: `job:${jobId.slice(2)}`,
        });
      }
      return validatorMcpBase.call(name, args);
    },
  };

  const workerStatus = await workerMcp.call(
    "agentpool_v43_wallet_status",
  );
  if (workerStatus.registered === false) {
    await workerMcp.call("agentpool_v43_register_onchain", {
      operatorGroup: "codex-pilot-worker",
      runtime: "agentpool-codex-runner-v1",
    });
  }
  await workerMcp.call(
    "agentpool_v43_publish_capacity_onchain",
    {
      capability,
      capacity: 2,
      expiresAt: deadline + 3_600,
      runtime: "agentpool-codex-runner-v1",
    },
  );

  const [supplyBefore, buyerBefore, workerBefore, validatorBefore] =
    await Promise.all([
      publicClient.readContract({
        address: deployment.contracts.token,
        abi: tokenAbi,
        functionName: "totalSupply",
      }),
      balance(accounts.buyer.address),
      balance(accounts.worker.address),
      balance(accounts.validator.address),
    ]);
  const created = await buyerMcp.call(
    "agentpool_v43_create_external_job",
    {
      plan: `${runId}-plan`,
      worker: accounts.worker.address,
      validatorRecipient: accounts.validator.address,
      capability,
      specification: `${runId}-specification`,
      expectedDelivery: expected,
      proofText: `${runId}-objective-proof`,
      workerAmountApool: "2",
      validatorAmountApool: "0.5",
      keeperAmountApool: "0.5",
      deadline,
      capacityUnits: 1,
      minimumReveals: 0,
      passScoreBps: 0,
      validatorRoot: `0x${"00".repeat(32)}`,
      minimumOperatorGroups: 0,
      runnerTaskJson: JSON.stringify({
        schema: "agentpool.runner.task/v1",
        kind: "AGENT_EXECUTE",
        provider: "codex",
        instruction: [
          `Set content to exactly ${expected}.`,
          "Set evidence.summary and evidence.digest to paid-codex-work.",
          "Set usage.mode to subscription and usage.units to 1.",
          "Do not add punctuation or explanatory text to content.",
        ].join(" "),
        networkAccess: false,
        workspaceMode: "ISOLATED_READ_ONLY",
      }),
    },
  );
  const jobId = created.jobId;

  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "agentpool-codex-paid-work-"),
  );
  temporaryHomes.push(workspace);
  const executorRegistry = createExecutorRegistry({
    allowProviderFallback: true,
    preferredProviders: ["codex", "claude", "qwen"],
    codex: {
      enabled: "auto",
      workspace,
      allowedWorkspaceRoots: [workspace],
      allowWorkspaceWrite: false,
      timeoutMs: 300_000,
    },
    claude: { enabled: false },
    qwen: { enabled: false },
  });
  const workerConfig = {
    roles: ["WORKER"],
    capabilities: [capability],
    minNetProfitApool: "0",
    estimatedCostApool: "0",
    estimatedGasApool: "0",
    autoResolveObjective: false,
    heartbeatIntervalMs: 0,
  };
  let workerState = newRunnerState();
  const workerCycle = await runRunnerCycle({
    config: workerConfig,
    mcp: workerMcp,
    state: workerState,
    executeTask: async (task, context) => {
      const adapted = await executeRunnerTaskWithAdapters(task, {
        ...context,
        config: workerConfig,
        executorRegistry,
      });
      assert.equal(typeof adapted, "string");
      return adapted;
    },
    sealResult: sealRunnerResultForBuyer,
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  workerState = workerCycle.state;
  assert.equal(workerState.jobs[jobId]?.stage, "DELIVERED");
  assert.equal(workerState.jobs[jobId]?.result, expected);

  const validatorWallet = await validatorMcp.call(
    "agentpool_v43_wallet_status",
  );
  const validatorCycle = await runValidatorCycle({
    config: { roles: ["VALIDATOR"] },
    mcp: validatorMcp,
    state: newRunnerState(),
    wallet: validatorWallet,
  });
  const settlement = validatorCycle.outcomes.find(
    (outcome) => outcome.status === "settled",
  );
  assert.ok(settlement);

  const [supplyAfter, buyerAfter, workerAfter, validatorAfter, job] =
    await Promise.all([
      publicClient.readContract({
        address: deployment.contracts.token,
        abi: tokenAbi,
        functionName: "totalSupply",
      }),
      balance(accounts.buyer.address),
      balance(accounts.worker.address),
      balance(accounts.validator.address),
      publicClient.readContract({
        address: deployment.contracts.taskMarket,
        abi: marketAbi,
        functionName: "jobs",
        args: [jobId],
      }),
    ]);
  assert.equal(supplyAfter, supplyBefore);
  assert.equal(workerAfter - workerBefore, 2n * 10n ** 18n);
  assert.equal(
    validatorAfter - validatorBefore,
    1n * 10n ** 18n,
  );
  assert.equal(buyerBefore - buyerAfter, 3n * 10n ** 18n);
  assert.equal(Number(job[2]), 4);

  const evidence = {
    ok: true,
    release: "4.3.5-staged-autonomy-alpha",
    runner: "0.9.0-v4.3.6-autonomy-runner",
    network: "Base Sepolia",
    chainId: 84532,
    testnetOnly: true,
    actualExecutor: "codex",
    optionalExecutorsRequired: false,
    jobId,
    buyer: accounts.buyer.address,
    worker: accounts.worker.address,
    validator: accounts.validator.address,
    expectedDelivery: expected,
    workerOutcome: workerCycle.outcomes,
    validatorOutcome: settlement,
    workerPaidApool: formatUnits(workerAfter - workerBefore, 18),
    validatorAndKeeperPaidApool: formatUnits(
      validatorAfter - validatorBefore,
      18,
    ),
    buyerSpentApool: formatUnits(buyerBefore - buyerAfter, 18),
    totalSupplyBeforeApool: formatUnits(supplyBefore, 18),
    totalSupplyAfterApool: formatUnits(supplyAfter, 18),
    externalJobEmissionApool: "0",
    privateKeysStoredOrExposed: false,
    completedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      jobId,
      workerPaidApool: evidence.workerPaidApool,
      validatorAndKeeperPaidApool:
        evidence.validatorAndKeeperPaidApool,
      supplyUnchanged: true,
      evidencePath,
    })}\n`,
  );
} finally {
  for (const client of clients.reverse()) {
    await client.close().catch(() => {});
  }
  for (const directory of temporaryHomes) {
    const resolved = path.resolve(directory);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}
