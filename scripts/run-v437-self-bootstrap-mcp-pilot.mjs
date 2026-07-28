import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const outputPath = path.join(
  root,
  "deployments",
  "84532.v43.7.self-bootstrap-pilot.json",
);
if (fs.existsSync(outputPath)) throw new Error("V437_PILOT_ALREADY_COMPLETE");
if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY_MISSING");
}
const client = new Client(
  { name: "agentpool-v437-self-bootstrap-pilot", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "mcp", "agentpool-v43.mjs")],
  env: {
    ...process.env,
    AGENTPOOL_V43_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY,
    AGENTPOOL_V43_RPC_URL:
      process.env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org",
  },
  stderr: "pipe",
});
const calls = [];
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const raw = result.content[0].text;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`V437_MCP_TOOL_FAILED:${name}:${raw}`);
  }
  calls.push({ name, args, result: payload });
  return payload;
};

try {
  await client.connect(transport);
  const before = await call("agentpool_v437_self_bootstrap_status");
  if (!before.open) {
    throw new Error(`V437_PILOT_POOL_NOT_READY:${JSON.stringify(before)}`);
  }
  const issueId = "V437_UNKNOWN_AGENT_STRUCTURED_ERROR";
  let issueState = await call(
    "agentpool_v437_self_bootstrap_issue",
    { issueId },
  );
  let issue;
  if (issueState.state === "NONE") {
    issue = await call("agentpool_v437_open_self_improvement", {
      issueId,
      issueHash: "UNKNOWN_AGENT_UNSTRUCTURED_ERROR",
      scope: "MCP",
      budgetCapApool: "1.5",
      specification:
        "Unknown local agent opportunity lookup returns a structured recoverable error",
      candidateRelease: "V437_MCP_STRUCTURED_ERROR_OVERLAY",
      planningMinutes: 30,
      executionMinutes: 120,
      settlementMinutes: 240,
    });
    issueState = await call(
      "agentpool_v437_self_bootstrap_issue",
      { issueId },
    );
  } else {
    issue = {
      recovered: true,
      issueId: issueState.issueId,
      state: issueState.state,
    };
  }
  const work = [
    {
      role: "REPRODUCER",
      itemId: "V437_UNKNOWN_AGENT_REPRODUCTION",
      quoteApool: "0.25",
      specification: "Reproduce UNKNOWN_AGENT against the local MCP",
      delivery: "UNKNOWN_AGENT reproduced before the structured error patch",
      proof: "tests/mcp.test.mjs regression fixture records the old failure mode",
    },
    {
      role: "IMPLEMENTER",
      itemId: "V437_UNKNOWN_AGENT_IMPLEMENTATION",
      quoteApool: "0.75",
      specification:
        "Return code, recovery tool, anonymous discovery availability, and an empty opportunity list",
      delivery:
        "mcp/agentpool-v43.mjs structured UNKNOWN_AGENT response implementation",
      proof:
        "source contains code UNKNOWN_AGENT, nextTool agentpool_v43_register_agent, and anonymousDiscoveryAvailable true",
    },
    {
      role: "VALIDATOR",
      itemId: "V437_UNKNOWN_AGENT_VALIDATION",
      quoteApool: "0.5",
      specification:
        "The MCP regression test must parse the response without a thrown transport error",
      delivery: "focused MCP and runner surface tests passed",
      proof: "node --test tests/mcp.test.mjs tests/v43-runner-surface.test.mjs:pass",
    },
  ];
  for (const item of work) {
    item.evidence = await call("agentpool_v437_prepare_evidence", {
      specification: item.specification,
      delivery: item.delivery,
      proof: item.proof,
    });
    const existing = issueState.items.find(
      (candidate) => candidate.role === item.role,
    );
    item.acceptance = existing ?? await call(
      "agentpool_v437_accept_work_bid",
      {
        issueId,
        itemId: item.itemId,
        role: item.role,
        quoteApool: item.quoteApool,
        specificationHash: item.evidence.specificationHash,
        expectedEvidenceHash: item.evidence.expectedEvidenceHash,
      },
    );
  }
  for (const item of work) {
    if (item.acceptance.state === "COMPLETED" || item.acceptance.state === "PAID") {
      item.completion = { recovered: true, state: item.acceptance.state };
    } else {
      item.completion = await call("agentpool_v437_complete_work", {
        itemId: item.itemId,
        deliveryHash: item.evidence.deliveryHash,
        proof: item.evidence.proof,
      });
    }
  }
  issueState = await call(
    "agentpool_v437_self_bootstrap_issue",
    { issueId },
  );
  const settlement =
    issueState.state === "SETTLED"
      ? { recovered: true, state: "SETTLED" }
      : await call(
          "agentpool_v437_settle_self_improvement",
          { issueId },
        );
  const after = await call("agentpool_v437_self_bootstrap_status");
  const wallet = await call("agentpool_v43_wallet_status");
  const report = {
    ok:
      after.paidApool === "1.5" &&
      after.availableApool === "8.5" &&
      wallet.tApool === "5.51",
    network: "Base Sepolia",
    chainId: 84532,
    release: "4.3.7-self-bootstrap-overlay-alpha",
    sameAiAcrossRoles: true,
    dynamicRoleQuotes: Object.fromEntries(
      work.map(({ role, quoteApool }) => [role, quoteApool]),
    ),
    totalPaidApool: after.paidApool,
    remainingPoolApool: after.availableApool,
    issue,
    settlement,
    wallet: {
      address: wallet.address,
      tApool: wallet.tApool,
      baseSepoliaEth: wallet.baseSepoliaEth,
    },
    transactionHashes: calls
      .map(({ result }) => result.transactionHash)
      .filter(Boolean),
    calls,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    throw new Error(`V437_PILOT_ASSERTION_FAILED:${outputPath}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      transactions: report.transactionHashes,
      totalPaidApool: report.totalPaidApool,
      remainingPoolApool: report.remainingPoolApool,
      worker: report.wallet.address,
      outputPath,
    })}\n`,
  );
} finally {
  await client.close();
}
