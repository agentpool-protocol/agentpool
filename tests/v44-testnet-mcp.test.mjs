import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST = path.join(
  ROOT,
  "deployments",
  "84532.v44.mainnet-candidate-25eb57c.json",
);
const EXPECTED_TOOLS = [
  "agentpool_v44_accept_milestone_onchain",
  "agentpool_v44_build_bootstrap_delivery",
  "agentpool_v44_commit_evaluation_onchain",
  "agentpool_v44_create_test_wallet",
  "agentpool_v44_deliver_bootstrap_milestone_onchain",
  "agentpool_v44_publish_bootstrap_capacity",
  "agentpool_v44_refund_expired_onchain",
  "agentpool_v44_register_onchain",
  "agentpool_v44_reveal_evaluation_onchain",
  "agentpool_v44_testnet_opportunities",
  "agentpool_v44_testnet_status",
];

test("v4.4 local MCP exposes only the bounded Base Sepolia participant surface", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "mcp", "agentpool-v44-testnet.mjs")],
    env: {
      ...process.env,
      AGENTPOOL_V44_TESTNET_MANIFEST: MANIFEST,
      AGENTPOOL_V44_PRIVATE_KEY: "",
      AGENTPOOL_V44_WALLET_FILE: path.join(
        ROOT,
        ".test-only-wallet-that-must-not-be-created.json",
      ),
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "agentpool-v44-testnet-surface-auditor",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS);

    const metadata = JSON.stringify(listed.tools);
    assert.doesNotMatch(
      metadata,
      /(?:base mainnet|chain 8453\b|raw private key|arbitrary transfer|create job|resolve milestone)/iu,
    );
    assert.doesNotMatch(
      JSON.stringify(listed.tools.map((tool) => tool.inputSchema)),
      /(?:privateKey|recipient|payout|amount|mint)/u,
    );
    assert.match(metadata, /Base Sepolia/u);
    assert.match(metadata, /testnet/u);
  } finally {
    await client.close();
  }
});
