import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = await mkdtemp(
  path.join(os.tmpdir(), "agentpool-v43-external-pilot-"),
);
const outputPath = path.join(root, "outputs", "v43.5-external-mcp-pilot.json");
const requiredTools = [
  "agentpool_v43_chain_status",
  "agentpool_v43_wallet_status",
  "agentpool_v43_create_test_wallet",
  "agentpool_v43_register_onchain",
  "agentpool_v43_publish_capacity_onchain",
  "agentpool_v43_create_external_job",
  "agentpool_v43_create_external_dag_onchain",
  "agentpool_v43_hold_budget_onchain",
  "agentpool_v43_replan_external_dag_onchain",
  "agentpool_v43_create_bootstrap_improvement_job",
  "agentpool_v43_accept_milestone_onchain",
  "agentpool_v43_deliver_milestone_onchain",
  "agentpool_v43_commit_evaluation_onchain",
  "agentpool_v43_reveal_evaluation_onchain",
  "agentpool_v43_resolve_milestone_onchain",
  "agentpool_v43_attest_candidate_onchain",
  "agentpool_v43_prove_release_onchain",
  "agentpool_v43_propose_recommendation_onchain",
  "agentpool_v43_commit_recommendation_vote_onchain",
  "agentpool_v43_reveal_recommendation_vote_onchain",
  "agentpool_v43_finalize_recommendation_onchain",
  "agentpool_v43_record_adoption_onchain",
  "agentpool_v43_propose_system_issue_onchain",
  "agentpool_v43_commit_system_issue_vote_onchain",
  "agentpool_v43_reveal_system_issue_vote_onchain",
  "agentpool_v43_finalize_system_issue_onchain",
];

function parseTool(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "public", "agentpool-mcp.mjs")],
  env: {
    ...process.env,
    AGENTPOOL_V43_HOME: tempHome,
    AGENTPOOL_V43_PRIVATE_KEY: "",
  },
  stderr: "pipe",
});
const client = new Client({
  name: "zero-context-external-ai-pilot",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  for (const tool of requiredTools) {
    assert.ok(toolNames.includes(tool), `${tool} is missing`);
  }

  const chain = parseTool(
    await client.callTool({
      name: "agentpool_v43_chain_status",
      arguments: {},
    }),
  );
  const wallet = parseTool(
    await client.callTool({
      name: "agentpool_v43_wallet_status",
      arguments: {},
    }),
  );

  assert.equal(chain.chainId, 84532);
  assert.equal(chain.network, "Base Sepolia");
  assert.equal(chain.release, "4.3.5-staged-autonomy-alpha");
  assert.equal(wallet.configured, false);
  assert.equal(wallet.custody, "device-local-only");

  const evidence = {
    ok: true,
    client: "zero-context-generic-mcp-client",
    inputKnowledge: "public downloadable MCP bundle only",
    bundle: "public/agentpool-mcp.mjs",
    network: chain.network,
    chainId: chain.chainId,
    release: chain.release,
    phase: chain.phase,
    taskMarket: chain.contracts.taskMarket,
    discoveredToolCount: toolNames.length,
    requiredParticipationToolsPresent: requiredTools,
    walletCreated: false,
    walletConfigured: wallet.configured,
    privateKeyRequestedOrExposed: false,
    writeTransactionSent: false,
    boundary:
      "The external AI discovered live Base Sepolia participation tools without receiving a key or spending gas.",
    completedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...evidence, evidencePath: outputPath }));
} finally {
  await client.close();
  const resolved = path.resolve(tempHome);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
  await rm(resolved, { recursive: true, force: true });
}
