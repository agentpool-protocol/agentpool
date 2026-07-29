#!/usr/bin/env node
import fs from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  executeBuiltinTask,
  newRunnerState,
  parseMcpToolResult,
  runRunnerCycle,
} from "./agentpool-runner-core.mjs";
import { createExecutorRegistry } from "./execution-adapters.mjs";
import {
  executeRunnerTaskWithAdapters,
  runAutonomyRoleCycle,
  runIdleImprovementCycle,
  runValidatorCycle,
  sealRunnerResultForBuyer,
} from "./agentpool-role-runner-core.mjs";
import { generatePrivateChannelKeyPair } from "./private-channel.mjs";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(
  process.env.AGENTPOOL_RUNNER_CONFIG ??
    path.join(root, "runner", "runner.config.json"),
);
const once = process.argv.includes("--once");

async function loadConfig() {
  const configured = fs.existsSync(configPath)
    ? JSON.parse(await readFile(configPath, "utf8"))
    : { chainId: 84532, testnetOnly: true };
  if (configured.chainId !== 84532 || configured.testnetOnly !== true) {
    throw new Error("RUNNER_BASE_SEPOLIA_ONLY");
  }
  const siblingMcp = path.join(runtimeDir, "agentpool-mcp.mjs");
  const defaults = {
    relayUrl: "https://agentpool-protocol.asfu.chatgpt.site",
    mcpPath: fs.existsSync(siblingMcp)
      ? siblingMcp
      : path.join(root, "public", "agentpool-mcp.mjs"),
    pollIntervalMs: 15_000,
    minimumGasEth: "0.000001",
    gasGrantRetryMs: 300_000,
    minNetProfitApool: "0",
    estimatedCostApool: "0",
    estimatedGasApool: "0",
    autoResolveObjective: false,
    capabilities: ["mcp-json-data-code-low-risk"],
    roles: [
      "WORKER",
      "PLANNER",
      "BIDDER",
      "COORDINATOR",
      "WATCHER",
      "IMPROVER",
    ],
    executors: {
      codex: {
        enabled: "auto",
      },
    },
    preferredProviders: ["codex", "claude", "qwen"],
    allowProviderFallback: true,
    improvementProvider: "codex",
    idleImprovement: {
      enabled: true,
      provider: "codex",
      auditIntervalMs: 60 * 60 * 1_000,
      retryIntervalMs: 10 * 60 * 1_000,
      successProbabilityBps: 7_500,
      estimatedCostApool: "0",
      estimatedGasApool: "0",
      failureLossApool: "0",
    },
    operatorGroup: "codex-single-device",
    runtime: "agentpool-codex-runner-v1",
    maximumConsecutiveFailures: 20,
    retryBackoffMs: 5_000,
    heartbeatIntervalMs: 60_000,
    autoCreateTestnetWallet: true,
    autoCreatePrivateChannelKey: true,
  };
  const merged = { ...defaults, ...configured };
  merged.privateChannelPrivateKey =
    process.env.AGENTPOOL_PRIVATE_CHANNEL_KEY ??
    merged.privateChannelPrivateKey;
  merged.privateChannelPublicKey =
    process.env.AGENTPOOL_PRIVATE_CHANNEL_PUBLIC_KEY ??
    merged.privateChannelPublicKey;
  merged.mcpPath = path.isAbsolute(merged.mcpPath)
    ? merged.mcpPath
    : path.resolve(path.dirname(configPath), merged.mcpPath);
  return merged;
}

async function readState(statePath) {
  if (!fs.existsSync(statePath)) return newRunnerState();
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.schema !== "agentpool.runner.state/v1") {
    throw new Error("RUNNER_STATE_SCHEMA_MISMATCH");
  }
  return state;
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, statePath);
}

async function ensurePrivateChannel(config, runnerHome) {
  if (
    Boolean(config.privateChannelPrivateKey) !==
    Boolean(config.privateChannelPublicKey)
  ) {
    throw new Error("RUNNER_PRIVATE_CHANNEL_KEY_PAIR_INCOMPLETE");
  }
  if (
    config.privateChannelPrivateKey &&
    config.privateChannelPublicKey
  ) {
    return;
  }
  const keyPath = path.join(runnerHome, "private-channel.json");
  if (fs.existsSync(keyPath)) {
    const stored = JSON.parse(await readFile(keyPath, "utf8"));
    config.privateChannelPrivateKey ??= stored.privateKey;
    config.privateChannelPublicKey ??= stored.publicKey;
    return;
  }
  if (config.autoCreatePrivateChannelKey !== true) return;
  const generated = await generatePrivateChannelKeyPair();
  await mkdir(runnerHome, { recursive: true });
  await writeFile(
    keyPath,
    `${JSON.stringify(generated, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  config.privateChannelPrivateKey = generated.privateKey;
  config.privateChannelPublicKey = generated.publicKey;
}

async function prepareSourceSnapshot(workspaceRoot) {
  const snapshot = path.join(
    workspaceRoot,
    `agentpool-source-${process.pid}`,
  );
  await mkdir(snapshot, { recursive: true });
  const entries = [
    "app",
    "contracts",
    "db",
    "lib",
    "mcp",
    "runner",
    "scripts",
    "sdk",
    "tests",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "README.md",
  ];
  for (const entry of entries) {
    const source = path.join(root, entry);
    if (!fs.existsSync(source)) continue;
    await cp(source, path.join(snapshot, entry), {
      recursive: true,
      force: true,
      filter: (candidate) => {
        const relative = path.relative(root, candidate);
        return !relative
          .split(path.sep)
          .some((segment) =>
            [
              ".git",
              ".next",
              "dist",
              "node_modules",
              "outputs",
            ].includes(segment),
          );
      },
    });
  }
  return snapshot;
}

async function main() {
  const config = await loadConfig();
  const runnerHome = path.resolve(
    process.env.AGENTPOOL_RUNNER_HOME ??
      config.runnerHome ??
      path.join(os.homedir(), ".agentpool-runner"),
  );
  const statePath = path.join(runnerHome, "state.json");
  const workspaceRoot = path.join(
    root,
    "work",
    "agentpool-runner",
  );
  await mkdir(workspaceRoot, { recursive: true });
  const codexWorkspace = await prepareSourceSnapshot(workspaceRoot);
  config.executors ??= {};
  config.executors.codex = {
    enabled: "auto",
    workspace: codexWorkspace,
    allowedWorkspaceRoots: [workspaceRoot],
    allowWorkspaceWrite: true,
    skipGitRepoCheck: true,
    ignoreUserConfig: true,
    ignoreRules: true,
    ...(config.executors.codex ?? {}),
  };
  config.executors.preferredProviders =
    config.preferredProviders ?? ["codex", "claude", "qwen"];
  config.executors.allowProviderFallback =
    config.allowProviderFallback !== false;
  config.bidProfiles ??= config.capabilities.map((capability) => ({
    enabled: true,
    capability,
    provider: "codex",
    priceApool: "0.1",
    bidShareBps: 5_000,
    successLowerBps: 8_500,
    capacityUnits: 1,
    latencyPenaltyApool: "0.01",
    failureLossApool: "0.1",
    concentrationPenaltyApool: "0",
  }));
  await ensurePrivateChannel(config, runnerHome);
  const childEnv = {
    ...process.env,
    AGENTPOOL_V43_RELAY_URL: config.relayUrl,
  };
  const walletHome =
    process.env.AGENTPOOL_V43_HOME ?? config.walletHome;
  const rpcUrl = process.env.AGENTPOOL_V43_RPC_URL ?? config.rpcUrl;
  if (walletHome) childEnv.AGENTPOOL_V43_HOME = walletHome;
  if (rpcUrl) childEnv.AGENTPOOL_V43_RPC_URL = rpcUrl;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [config.mcpPath],
    env: childEnv,
    stderr: "pipe",
  });
  const client = new Client({
    name: "agentpool-autonomous-runner",
    version: "1.0.0",
  });
  await client.connect(transport);
  const mcp = {
    async call(name, args) {
      return parseMcpToolResult(
        await client.callTool({ name, arguments: args }),
        name,
      );
    },
  };
  const executorRegistry = createExecutorRegistry(config.executors);
  let state = await readState(statePath);
  let consecutiveFailures = 0;
  const runCycle = async () => {
    const workerResult = await runRunnerCycle({
      config,
      mcp,
      state,
      executeTask: async (task, context) => {
        const adapted = await executeRunnerTaskWithAdapters(task, {
          ...context,
          config,
          executorRegistry,
        });
        return adapted ?? executeBuiltinTask(task);
      },
      sealResult: sealRunnerResultForBuyer,
      fetchChainSnapshot: async () => {
        const response = await fetch(
          new URL("/api/v4.3/opportunities", config.relayUrl),
          { headers: { accept: "application/json" } },
        );
        if (!response.ok) {
          throw new Error(`RUNNER_CHAIN_SNAPSHOT_FAILED:${response.status}`);
        }
        return response.json();
      },
    });
    state = workerResult.state;
    const autonomyResult = await runAutonomyRoleCycle({
      config,
      mcp,
      state,
      wallet: workerResult.wallet,
      executorRegistry,
    });
    state = autonomyResult.state;
    const idleImprovementResult =
      await runIdleImprovementCycle({
        config,
        mcp,
        state,
        wallet: workerResult.wallet,
        executorRegistry,
        marketOutcomes: autonomyResult.outcomes,
      });
    state = idleImprovementResult.state;
    const validationResult = await runValidatorCycle({
      config,
      mcp,
      state,
      wallet: workerResult.wallet,
    });
    state = validationResult.state;
    await saveState(statePath, state);
    process.stdout.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        address: workerResult.wallet.address,
        onboarding: workerResult.onboarding,
        providers: executorRegistry.providers(),
        outcomes: [
          ...workerResult.outcomes,
          ...autonomyResult.outcomes,
          ...idleImprovementResult.outcomes,
          ...validationResult.outcomes,
        ],
      })}\n`,
    );
  };
  try {
    do {
      try {
        await runCycle();
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        process.stderr.write(
          `${JSON.stringify({
            at: new Date().toISOString(),
            consecutiveFailures,
            recoverable: !once,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        if (
          once ||
          consecutiveFailures >=
            Number(config.maximumConsecutiveFailures)
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              60_000,
              Number(config.retryBackoffMs) *
                2 ** Math.min(consecutiveFailures - 1, 4),
            ),
          ),
        );
      }
      if (!once) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.pollIntervalMs),
        );
      }
    } while (!once);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
