import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = await mkdtemp(
  path.join(os.tmpdir(), "agentpool-v43-qwen-discovery-"),
);
const outputPath = path.join(
  root,
  "outputs",
  "v43.4-qwen-zero-context-mcp.json",
);
const ollamaHost = (
  process.env.OLLAMA_HOST || "http://127.0.0.1:11434"
).replace(/\/$/, "");
const model = process.env.AGENTPOOL_QWEN_MODEL || "qwen2.5-coder:14b";
const allowedToolNames = [
  "agentpool_v43_status",
  "agentpool_v43_chain_status",
  "agentpool_v43_opportunities",
];

function parseToolResult(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

function parseTextToolCalls(content) {
  const normalized = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!normalized.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(normalized);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      function: {
        name: entry?.name,
        arguments: entry?.arguments || {},
      },
      transport: "text-json",
    }));
  } catch {
    return [];
  }
}

async function chat(messages, tools, format) {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      ...(format ? { format } : {}),
      stream: false,
      options: {
        temperature: 0,
        num_ctx: 16_384,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OLLAMA_CHAT_FAILED:${response.status}:${await response.text()}`,
    );
  }
  return response.json();
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
  name: "qwen-zero-context-agentpool-pilot",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const listedNames = listed.tools.map((tool) => tool.name);
  for (const name of allowedToolNames) {
    assert.ok(listedNames.includes(name), `${name} is missing`);
  }
  const allowedTools = listed.tools.filter((tool) =>
    allowedToolNames.includes(tool.name),
  );
  const ollamaTools = allowedTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  const messages = [
    {
      role: "system",
      content:
        "You are an external AI with no prior AgentPool knowledge. The only " +
        "authoritative information available to you is MCP tools/list metadata " +
        "and results from the three read-only AgentPool MCP tools. Call all " +
        "three tools before answering. Never request a wallet and never send a " +
        "transaction. Clearly separate observed facts from unavailable facts.",
    },
    {
      role: "user",
      content:
        `AgentPool MCP tools/list returned ${listed.tools.length} tools. ` +
        "Discover the live release, chainId, phase, job count, markets, whether " +
        "generic basic mining exists, and whether external jobs mint tAPOOL. " +
        "Use the available read-only MCP tools. Return a concise report.",
    },
  ];
  const calls = [];
  const results = {};
  const modelTrace = [];
  let finalAnswer = "";
  const finalSchema = {
    type: "object",
    properties: {
      release: { type: "string" },
      chainId: { type: "integer" },
      phase: { type: "string" },
      mcpToolCount: { type: "integer" },
      localJobCount: { type: "integer" },
      anonymousOpportunityCount: { type: "integer" },
      markets: {
        type: "array",
        items: { type: "string" },
      },
      genericBasicMining: { type: "boolean" },
      externalJobsMintTapool: { type: "boolean" },
    },
    required: [
      "release",
      "chainId",
      "phase",
      "mcpToolCount",
      "localJobCount",
      "anonymousOpportunityCount",
      "markets",
      "genericBasicMining",
      "externalJobsMintTapool",
    ],
  };

  for (let turn = 0; turn < 8; turn++) {
    const allObserved = allowedToolNames.every((name) => name in results);
    if (allObserved) {
      messages.push({
        role: "user",
        content:
          "All required MCP observations are now present. Do not call more " +
          "tools. Summarize only the observed release, chainId, phase, MCP " +
          "tool count, job counts, markets, generic-basic-mining status, and " +
          "external-job minting rule.",
      });
    }
    const response = await chat(
      messages,
      allObserved ? [] : ollamaTools,
      allObserved ? finalSchema : undefined,
    );
    const message = response.message;
    assert.equal(message?.role, "assistant");
    const nativeToolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    const toolCalls =
      nativeToolCalls.length > 0
        ? nativeToolCalls.map((toolCall) => ({
            ...toolCall,
            transport: "native",
          }))
        : allObserved
          ? []
          : parseTextToolCalls(message.content);
    modelTrace.push({
      turn,
      content: message.content || "",
      thinking: message.thinking
        ? String(message.thinking).slice(-1_000)
        : "",
      toolCalls: toolCalls.map((toolCall) => toolCall.function?.name),
      doneReason: response.done_reason,
    });
    if (toolCalls.length === 0) {
      const missing = allowedToolNames.filter((name) => !(name in results));
      if (missing.length > 0) {
        messages.push(message);
        messages.push({
          role: "user",
          content: `You must call these remaining read-only MCP tools before answering: ${missing.join(", ")}`,
        });
        continue;
      }
      finalAnswer = message.content || "";
      break;
    }

    messages.push(message);
    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      assert.ok(
        allowedToolNames.includes(name),
        `QWEN_REQUESTED_NON_READ_TOOL:${name}`,
      );
      const args = toolCall.function?.arguments || {};
      const result = parseToolResult(
        await client.callTool({
          name,
          arguments: args,
        }),
      );
      calls.push({
        name,
        arguments: args,
        transport: toolCall.transport,
      });
      results[name] = result;
      if (toolCall.transport === "native") {
        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify(result),
        });
      } else {
        messages.push({
          role: "user",
          content:
            `Authoritative MCP result for ${name}: ` +
            JSON.stringify(result),
        });
      }
    }
  }

  assert.ok(
    finalAnswer,
    `QWEN_DID_NOT_PRODUCE_FINAL_ANSWER:${JSON.stringify(modelTrace)}`,
  );
  for (const name of allowedToolNames) {
    assert.ok(name in results, `QWEN_DID_NOT_CALL:${name}`);
  }

  const chain = results.agentpool_v43_chain_status;
  const status = results.agentpool_v43_status;
  const opportunities = results.agentpool_v43_opportunities;
  const finalReport = JSON.parse(finalAnswer);
  assert.equal(finalReport.release, chain.release);
  assert.equal(finalReport.chainId, chain.chainId);
  assert.equal(finalReport.phase, chain.phase);
  assert.equal(finalReport.mcpToolCount, listed.tools.length);
  assert.equal(finalReport.localJobCount, status.opportunities.length);
  assert.equal(
    finalReport.anonymousOpportunityCount,
    opportunities.opportunities.length,
  );
  assert.deepEqual(finalReport.markets, chain.markets);
  assert.equal(
    finalReport.genericBasicMining,
    chain.genericBasicMining,
  );
  assert.equal(
    finalReport.externalJobsMintTapool,
    chain.externalJobsMintTapool,
  );
  const evidence = {
    ok: true,
    model,
    client: "ollama-qwen-tool-calling",
    inputKnowledge: "MCP tools/list metadata and read-only MCP results only",
    listedToolCount: listed.tools.length,
    allowedTools: allowedToolNames,
    calls,
    observed: {
      release: chain.release,
      chainId: chain.chainId,
      phase: chain.phase,
      markets: chain.markets,
      genericBasicMining: chain.genericBasicMining,
      externalJobsMintTapool: chain.externalJobsMintTapool,
      localJobCount: status.opportunities.length,
      anonymousOpportunityCount: opportunities.opportunities.length,
      walletCreated: false,
      transactionSent: false,
    },
    finalAnswer,
    finalReport,
    completedAt: new Date().toISOString(),
  };
  assert.equal(evidence.observed.chainId, 84532);
  assert.equal(evidence.observed.genericBasicMining, false);
  assert.equal(evidence.observed.externalJobsMintTapool, false);
  assert.equal(evidence.observed.walletCreated, false);
  assert.equal(evidence.observed.transactionSent, false);
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
