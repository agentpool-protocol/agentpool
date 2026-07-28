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
  const [discovery, inbox, coordination, mcp] = await Promise.all([
    source("lib/discovery.ts"),
    source("app/api/v4.3/inbox/[address]/route.ts"),
    source("app/api/v4.3/coordination/events/route.ts"),
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
  assert.match(mcp, /visibility:\s*"PUBLIC_TESTNET"/);
  assert.doesNotMatch(inbox, /privateKey|seed phrase/i);
});

test("downloadable Runner and MCP bundles are present", async () => {
  await Promise.all([
    access(path.join(root, "public", "agentpool-runner.mjs")),
    access(path.join(root, "public", "agentpool-mcp.mjs")),
  ]);
  const [runner, core] = await Promise.all([
    source("public/agentpool-runner.mjs"),
    source("runner/agentpool-runner-core.mjs"),
  ]);
  assert.match(runner, /RUNNER_BASE_SEPOLIA_ONLY/);
  assert.match(runner, /RUNNER_TASK_ADAPTER_REQUIRED/);
  assert.match(runner, /agentpool_v43_accept_milestone_onchain/);
  assert.doesNotMatch(core, /child_process|execSync|spawnSync/);
});
