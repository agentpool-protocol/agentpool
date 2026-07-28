import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(file) {
  return readFile(path.join(root, file), "utf8");
}

test("public discovery exposes the Runner and buyer inbox without wallet custody", async () => {
  const [discovery, inbox, coordination, runners, mcp] = await Promise.all([
    source("lib/discovery.ts"),
    source("app/api/v4.3/inbox/[address]/route.ts"),
    source("app/api/v4.3/coordination/events/route.ts"),
    source("app/api/v4.3/runners/route.ts"),
    source("mcp/agentpool-v43.mjs"),
  ]);
  assert.match(discovery, /alwaysOnRunner/);
  assert.match(discovery, /v43BuyerInboxTemplate/);
  assert.match(inbox, /getV43BuyerInbox/);
  for (const eventType of [
    "JOB_TERMS",
    "RESULT_AVAILABLE",
    "SETTLEMENT_RECEIPT",
  ]) {
    assert.match(coordination, new RegExp(eventType));
    assert.match(mcp, new RegExp(eventType));
  }
  assert.match(mcp, /runnerTaskJson/);
  assert.match(mcp, /PUBLIC_TESTNET/);
  assert.match(mcp, /HPKE_TASK_AND_OPTIONAL_RESULT/);
  assert.match(runners, /RUNNER_HEARTBEAT/);
  assert.match(runners, /ACTIVE/);
  assert.match(runners, /operatorGroup/);
  assert.doesNotMatch(runners, /privateKey|seed phrase/i);
  assert.doesNotMatch(inbox, /privateKey|seed phrase/i);
});

test("downloadable Runner and MCP bundles are present", async () => {
  await Promise.all([
    access(path.join(root, "public", "agentpool-runner.mjs")),
    access(path.join(root, "public", "agentpool-mcp.mjs")),
    access(path.join(root, "public", "Install-AgentPoolCodexRunner.ps1")),
    access(path.join(root, "public", "Install-AgentPoolCodexRunner-v436.ps1")),
    access(path.join(root, "public", "start-agentpool-runner.cmd")),
  ]);
  const [runner, core, installer, launcher, worker] = await Promise.all([
    source("public/agentpool-runner.mjs"),
    source("runner/agentpool-runner-core.mjs"),
    source("public/Install-AgentPoolCodexRunner.ps1"),
    source("public/start-agentpool-runner.cmd"),
    source("worker/index.ts"),
  ]);
  assert.match(runner, /RUNNER_BASE_SEPOLIA_ONLY/);
  assert.match(runner, /RUNNER_TASK_ADAPTER_REQUIRED/);
  assert.match(runner, /agentpool_v43_accept_milestone_onchain/);
  assert.match(installer, /@openai\/codex@0\.145\.0/);
  assert.match(installer, /autoCreateTestnetWallet/);
  assert.match(launcher, /%~dp0Start-AgentPoolRunner\.ps1/);
  assert.match(worker, /agentpool-runner-v436\.mjs/);
  assert.match(worker, /agentpool-mcp-v435\.mjs/);
  assert.doesNotMatch(core, /child_process|execSync|spawnSync/);
});
