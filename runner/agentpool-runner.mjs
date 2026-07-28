#!/usr/bin/env node
import fs from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
    minNetProfitApool: "0",
    estimatedCostApool: "0",
    estimatedGasApool: "0",
    autoResolveObjective: false,
    capabilities: [],
  };
  const merged = { ...defaults, ...configured };
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

async function main() {
  const config = await loadConfig();
  const runnerHome = path.resolve(
    process.env.AGENTPOOL_RUNNER_HOME ??
      config.runnerHome ??
      path.join(os.homedir(), ".agentpool-runner"),
  );
  const statePath = path.join(runnerHome, "state.json");
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
  let state = await readState(statePath);
  const runCycle = async () => {
    const result = await runRunnerCycle({
      config,
      mcp,
      state,
      executeTask: executeBuiltinTask,
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
    state = result.state;
    await saveState(statePath, state);
    process.stdout.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        address: result.wallet.address,
        outcomes: result.outcomes,
      })}\n`,
    );
  };
  try {
    do {
      await runCycle();
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
