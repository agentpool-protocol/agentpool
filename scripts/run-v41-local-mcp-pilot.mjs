import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const executeFile = promisify(execFile);
const root = process.cwd();
const baseUrl =
  process.env.AGENTPOOL_BASE_URL?.replace(/\/+$/, "") ??
  "http://localhost:3100";
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const walletProfile = process.env.V41_WALLET_PROFILE?.trim();
const deployerKey = process.env.V41_DEPLOYER_PRIVATE_KEY?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL is required");
if (walletProfile !== "base-sepolia-disposable" || !deployerKey) {
  throw new Error("V41_LOCAL_PILOT_REQUIRES_DISPOSABLE_PROFILE");
}
if (!/^https?:\/\/localhost(?::\d+)?$/u.test(baseUrl)) {
  throw new Error("V41_LOCAL_PILOT_REQUIRES_LOCAL_GATEWAY");
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const tokenAbi = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "AgentPoolV41Token.json"), "utf8"),
).abi;
const workerHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "agentpool-v41-external-worker-"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "mcp", "agentpool-local.mjs")],
  env: {
    ...process.env,
    AGENTPOOL_BASE_URL: baseUrl,
    AGENTPOOL_RPC_URL: rpcUrl,
    AGENTPOOL_MCP_HOME: workerHome,
  },
  stderr: "pipe",
});
const client = new Client({
  name: "agentpool-v41-independent-pilot",
  version: "1.0.0",
});
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const deployer = privateKeyToAccount(deployerKey);
const deployerClient = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport: http(rpcUrl),
});

function payload(result) {
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "MCP tool failed");
  }
  return (
    result.structuredContent ??
    JSON.parse(result.content?.[0]?.text ?? "{}")
  );
}

async function call(name, args = {}) {
  return payload(await client.callTool({ name, arguments: args }));
}

function solveCapability(challenge) {
  if (challenge.type !== "json-normalize" || !Array.isArray(challenge.input)) {
    throw new Error("V41_LOCAL_PILOT_UNEXPECTED_CAPABILITY_TASK");
  }
  const unique = new Map();
  for (const row of challenge.input) {
    unique.set(row.id, Math.max(unique.get(row.id) ?? 0, row.score));
  }
  return {
    rows: Array.from(unique, ([id, score]) => ({ id, score })).sort(
      (left, right) => left.id.localeCompare(right.id),
    ),
  };
}

function solvePilot(task) {
  if (
    task?.type !== "canonical-mcp-fixture" ||
    !Array.isArray(task.input)
  ) {
    throw new Error("V41_LOCAL_PILOT_UNEXPECTED_WORK_TASK");
  }
  const unique = new Map();
  for (const row of task.input) unique.set(row.id, row);
  return {
    fixtures: Array.from(unique.values())
      .map((row) => ({
        id: row.id,
        method: String(row.method).toUpperCase(),
        path: String(row.path).toLowerCase(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

let completed = false;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  for (const name of [
    "agentpool_create_test_wallet",
    "agentpool_v41_start_capability",
    "agentpool_v41_submit_capability",
    "agentpool_v41_commit_bid",
    "agentpool_v41_reveal_bid",
    "agentpool_v41_assignments",
    "agentpool_v41_complete_pilot",
  ]) {
    if (!tools.tools.some((tool) => tool.name === name)) {
      throw new Error(`V41_LOCAL_PILOT_MISSING_TOOL:${name}`);
    }
  }
  const wallet = await call("agentpool_create_test_wallet", {
    confirmation: "CREATE BASE SEPOLIA TEST WALLET",
  });
  const worker = wallet.address;
  const workerBalance = await publicClient.getBalance({ address: worker });
  let fundingHash = null;
  if (workerBalance < parseEther("0.000005")) {
    fundingHash = await deployerClient.sendTransaction({
      account: deployer,
      to: worker,
      value: parseEther("0.00001"),
    });
    const fundingReceipt = await publicClient.waitForTransactionReceipt({
      hash: fundingHash,
      confirmations: 2,
    });
    if (fundingReceipt.status !== "success") {
      throw new Error(`V41_LOCAL_PILOT_GAS_FUNDING_REVERTED:${fundingHash}`);
    }
  }
  const walletStatus = await call("agentpool_wallet_status");
  const capability = await call("agentpool_v41_start_capability", {
    track: "json",
    runtimeLabel: "external-mcp-pilot-runtime-v1",
    modelLabel: "unknown-external-agent",
  });
  const capabilityResult = solveCapability(capability.challenge);
  const measured = await call("agentpool_v41_submit_capability", {
    sessionId: capability.id,
    answer: capabilityResult,
    latencyMs: 1_000,
  });
  if (!measured.passed) {
    throw new Error("V41_LOCAL_PILOT_CAPABILITY_FAILED");
  }
  const opportunities = await call("agentpool_v41_opportunities", {
    market: "BASIC",
    agentCostApool: 20,
    successProbabilityBps: 9_000,
  });
  const opportunity = opportunities.opportunities.find(
    (candidate) => candidate.id === "v41-basic-mcp-fixture-1",
  );
  if (!opportunity?.pilot?.task) {
    throw new Error("V41_LOCAL_PILOT_OPPORTUNITY_UNAVAILABLE");
  }
  const committed = await call("agentpool_v41_commit_bid", {
    opportunityId: opportunity.id,
    profileId: capability.profileId,
    priceApool: "120",
    capacityUnits: 1,
    confirmation: "COMMIT BASE SEPOLIA TEST BID",
  });
  const revealed = await call("agentpool_v41_reveal_bid", {
    opportunityId: opportunity.id,
    confirmation: "REVEAL BASE SEPOLIA TEST BID",
  });
  const operator = await executeFile(
    process.execPath,
    [
      "--env-file-if-exists=.env.local",
      "--env-file-if-exists=.env.v41.local",
      "scripts/open-v41-external-pilot.mjs",
      "--bid-id",
      committed.id,
      "--base-url",
      baseUrl,
    ],
    {
      cwd: root,
      env: { ...process.env, AGENTPOOL_BASE_URL: baseUrl },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const opened = JSON.parse(operator.stdout.trim().split(/\r?\n/u).at(-1));
  const assignments = await call("agentpool_v41_assignments");
  const assignment = assignments.assignments.find(
    (candidate) => candidate.id === opened.assignmentId,
  );
  if (!assignment?.settlementTerms?.task) {
    throw new Error("V41_LOCAL_PILOT_ASSIGNMENT_NOT_DISCOVERED");
  }
  const workResult = solvePilot(assignment.settlementTerms.task);
  const settlement = await call("agentpool_v41_complete_pilot", {
    assignmentId: assignment.id,
    result: workResult,
    confirmation: "COMPLETE BASE SEPOLIA TEST PILOT",
  });
  if (settlement.state !== "SETTLED") {
    throw new Error("V41_LOCAL_PILOT_NOT_SETTLED");
  }
  const tokenBalance = await publicClient.readContract({
    address: manifest.contracts.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [worker],
  });
  if (tokenBalance !== 120n * 10n ** 18n) {
    throw new Error("V41_LOCAL_PILOT_WRONG_TOKEN_BALANCE");
  }
  const output = {
    ok: true,
    testnetOnly: true,
    chainId: 84532,
    gateway: baseUrl,
    worker,
    workerTestEthAfter: formatEther(
      await publicClient.getBalance({ address: worker }),
    ),
    capability: {
      profileId: capability.profileId,
      passed: measured.passed,
    },
    bid: {
      id: committed.id,
      state: revealed.state,
      priceApool: revealed.priceApool,
    },
    assignmentId: assignment.id,
    openTransactionHash: opened.openTransactionHash,
    actionTransactions: settlement.transactions.map(
      (transaction) => transaction.transactionHash,
    ),
    finalState: settlement.state,
    balanceTapool: formatUnits(tokenBalance, manifest.token.decimals),
    checks: {
      separateWorkerWallet: worker.toLowerCase() !== deployer.address.toLowerCase(),
      capabilityPassed: measured.passed === true,
      bidRevealed: revealed.state === "REVEALED",
      assignmentDiscoveredThroughMcp: true,
      resultVerifiedLocally: settlement.resultHash === opened.expectedResultHash,
      exactPayout: tokenBalance === 120n * 10n ** 18n,
      settled: settlement.state === "SETTLED",
    },
    fundingTransactionHash: fundingHash,
    completedAt: new Date().toISOString(),
  };
  if (!Object.values(output.checks).every(Boolean)) {
    throw new Error(`V41_LOCAL_PILOT_CHECK_FAILED:${JSON.stringify(output.checks)}`);
  }
  const outputPath = path.join(
    root,
    "outputs",
    `v41-local-mcp-pilot-${assignment.id.slice(2, 14)}.json`,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  completed = true;
  process.stdout.write(`${JSON.stringify({ ...output, outputPath })}\n`);
} finally {
  await client.close().catch(() => undefined);
  if (completed) {
    fs.rmSync(workerHome, { recursive: true, force: true });
  }
}
