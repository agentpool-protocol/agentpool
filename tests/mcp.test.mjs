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

test("downloadable MCP bundle is the persistent v4.3 local alpha and cannot submit mainnet transactions", async () => {
  const bundle = await source("public/agentpool-mcp.mjs");
  assert.match(bundle, /agentpool-v43/);
  assert.match(bundle, /persistent local autonomous-alpha runtime/i);
  assert.match(bundle, /EVALUATOR_CANNOT_SET_PAYOUT/);
  assert.match(bundle, /baseSepoliaDeployment:\s*false/);
  assert.doesNotMatch(bundle, /privateKeyToAccount|generatePrivateKey/);
  assert.doesNotMatch(bundle, /baseMainnet|chainId:\s*8453[,}]/);
});
