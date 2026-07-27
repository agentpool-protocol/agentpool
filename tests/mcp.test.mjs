import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("public MCP is standard Streamable HTTP and exposes read-only tools only", async () => {
  const [route, http, tools, worker] = await Promise.all([
    source("app/api/mcp/route.ts"),
    source("lib/mcp-http.ts"),
    source("lib/mcp-public.ts"),
    source("worker/index.ts"),
  ]);
  assert.match(route, /handlePublicMcpRequest/);
  assert.match(http, /WebStandardStreamableHTTPServerTransport/);
  assert.match(http, /enableJsonResponse:\s*true/);
  assert.match(http, /requestOrigin !== endpointOrigin/);
  assert.match(http, /status:\s*403/);
  assert.match(worker, /url\.pathname === "\/api\/mcp"/);
  assert.match(worker, /handlePublicMcpRequest\(/);
  assert.match(worker, /handler\.fetch\(internalRequest, env, ctx\)/);
  for (const tool of [
    "agentpool_protocol_status",
    "agentpool_list_mining_tracks",
    "agentpool_list_agents",
    "agentpool_list_listings",
    "agentpool_list_jobs",
    "agentpool_mining_leaderboard",
    "agentpool_open_beta_guide",
  ]) {
    assert.match(tools, new RegExp(`"${tool}"`));
  }
  assert.doesNotMatch(
    tools,
    /registerTool\(\s*"agentpool_(?:create_test_wallet|start_mining|submit_mining_answer)"/,
  );
});

test("local MCP handshakes over stdio without creating a wallet", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "agentpool-mcp-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "agentpool-local.mjs")],
    env: {
      ...process.env,
      AGENTPOOL_MCP_HOME: tempHome,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "agentpool-test-client",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of [
      "agentpool_wallet_status",
      "agentpool_create_test_wallet",
      "agentpool_start_mining",
      "agentpool_submit_mining_answer",
      "agentpool_portfolio",
    ]) {
      assert.ok(names.includes(required), `${required} is missing`);
    }
    const status = await client.callTool({
      name: "agentpool_wallet_status",
      arguments: {},
    });
    const payload = JSON.parse(status.content[0].text);
    assert.equal(payload.exists, false);
    assert.equal(
      await source("mcp/agentpool-local.mjs").then((body) =>
        body.includes("EXPECTED_CHAIN_ID = 84532"),
      ),
      true,
    );
  } finally {
    await client.close();
    const resolved = path.resolve(tempHome);
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(
      resolved.startsWith(`${tempRoot}${path.sep}`),
      "temporary MCP test path escaped the OS temp directory",
    );
    await rm(resolved, { recursive: true, force: true });
  }
});

test("downloadable MCP bundle connects device-local wallets to v4.3.4 Base Sepolia only", async () => {
  const bundle = await source("public/agentpool-mcp.mjs");
  assert.match(bundle, /agentpool-v43/);
  assert.match(bundle, /agentpool_v43_create_test_wallet/);
  assert.match(bundle, /agentpool_v43_create_external_job/);
  assert.match(bundle, /agentpool_v43_create_bootstrap_improvement_job/);
  assert.match(bundle, /EVALUATOR_CANNOT_SET_PAYOUT/);
  assert.match(bundle, /device-local-only/);
  assert.match(bundle, /V43_RELEASE_NOT_USABLE/);
  assert.match(bundle, /selectedReleaseId/);
  assert.match(bundle, /V43_CHAIN_READ_REPLICA_LAG/);
  assert.match(bundle, /attempt\s*<=\s*8/);
  assert.match(bundle, /Base Sepolia/);
  assert.doesNotMatch(bundle, /baseMainnet|chainId:\s*8453[,}]/);
});

test("v4.3 MCP handshakes with zero context and exposes chain participation tools", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "agentpool-v43-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "agentpool-v43.mjs")],
    env: {
      ...process.env,
      AGENTPOOL_V43_HOME: tempHome,
      AGENTPOOL_V43_PRIVATE_KEY: "",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "zero-context-external-ai",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of [
      "agentpool_v43_chain_status",
      "agentpool_v43_wallet_status",
      "agentpool_v43_create_test_wallet",
      "agentpool_v43_register_onchain",
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
    ]) {
      assert.ok(names.includes(required), `${required} is missing`);
    }
    const status = await client.callTool({
      name: "agentpool_v43_wallet_status",
      arguments: {},
    });
    const payload = JSON.parse(status.content[0].text);
    assert.equal(payload.configured, false);
    assert.equal(payload.network, "Base Sepolia");
    const chainStatus = await client.callTool({
      name: "agentpool_v43_chain_status",
      arguments: {},
    });
    const chain = JSON.parse(chainStatus.content[0].text);
    assert.equal(chain.chainId, 84532);
    assert.equal(chain.network, "Base Sepolia");
    assert.equal(chain.release, "4.3.4-bootstrap-alpha");
    assert.equal(
      chain.contracts.taskMarket,
      "0xb21869c37d999682d3b7ed051dda968e08878d0a",
    );
  } finally {
    await client.close();
    const resolved = path.resolve(tempHome);
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  }
});
