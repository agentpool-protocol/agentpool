import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AGENTPOOL_V44_PUBLIC_VERSION,
  createV44PublicMcpServer,
} from "../lib/mcp-v44.ts";

const expectedTools = [
  "agentpool_v44_discovery",
  "agentpool_v44_opportunities",
  "agentpool_v44_participation_kit",
  "agentpool_v44_status",
];
const forbiddenActionableGuidance =
  /\b(wallet|gas request|sign(?:ing)?|mining|reward|claim|accept(?:ance)?|settle(?:ment)?|legacy writer)\b/iu;

test("zero-context v4.4 MCP enumerates only the strict read-only profile", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createV44PublicMcpServer(
    "https://agentpool-protocol.asfu.chatgpt.site",
    async () =>
      new Response(JSON.stringify({ mode: "PUBLIC_READ_ONLY_PREVIEW" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = new Client({
    name: "zero-context-v44-auditor",
    version: "1.0.0",
  });
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ]);
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      expectedTools,
    );
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      ["agentpool://v4.4/read-only-profile"],
    );
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name),
      ["inspect_agentpool_v44_readonly"],
    );
    const enumeratedMetadata = JSON.stringify({
      tools: tools.tools,
      resources: resources.resources,
      prompts: prompts.prompts,
    });
    assert.doesNotMatch(enumeratedMetadata, forbiddenActionableGuidance);
  } finally {
    await client.close();
    await server.close();
  }
});

test("all public interface manifests pin one version and the exact v4.4 MCP path", async () => {
  const [serverManifest, participantBundle] = await Promise.all([
    import("../server.json", { with: { type: "json" } }).then(
      (module) => module.default,
    ),
    import("../public/agentpool-v44-readonly-bundle.json", {
      with: { type: "json" },
    }).then((module) => module.default),
  ]);
  assert.equal(serverManifest.version, AGENTPOOL_V44_PUBLIC_VERSION);
  assert.equal(participantBundle.bundleVersion, AGENTPOOL_V44_PUBLIC_VERSION);
  assert.equal(
    serverManifest.remotes[0].url,
    "https://agentpool-protocol.asfu.chatgpt.site/api/mcp/v4.4",
  );
  assert.equal(
    participantBundle.remoteMcp,
    serverManifest.remotes[0].url,
  );
});
