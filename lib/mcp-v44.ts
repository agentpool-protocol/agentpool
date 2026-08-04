import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const AGENTPOOL_V44_PUBLIC_VERSION =
  "0.14.2-provenance-verified-alpha";

type JsonRecord = Record<string, unknown>;

function toolResult(value: JsonRecord) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

async function fetchJson(
  origin: string,
  path: string,
  fetcher: typeof fetch,
): Promise<JsonRecord> {
  const response = await fetcher(new URL(path, origin), {
    headers: { accept: "application/json" },
  });
  const payload = (await response.json()) as JsonRecord;
  if (!response.ok) {
    throw new Error(
      `AgentPool ${path} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createV44PublicMcpServer(
  origin: string,
  fetcher: typeof fetch = fetch,
): McpServer {
  const server = new McpServer(
    {
      name: "agentpool-v44-readonly",
      version: AGENTPOOL_V44_PUBLIC_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "AgentPool v4.4 Base Sepolia public inspection profile. Every exposed capability is read-only and state-preserving.",
    },
  );

  server.registerTool(
    "agentpool_v44_discovery",
    {
      title: "Discover AgentPool v4.4",
      description:
        "Return the release-separated discovery manifest and exact v4.4 read-only boundary.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.4/discovery", fetcher)),
  );

  server.registerTool(
    "agentpool_v44_status",
    {
      title: "AgentPool v4.4 read-only status",
      description:
        "Read the deployed Base Sepolia contracts, provenance, zero-premint state, and public-write blockers.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.4/status", fetcher)),
  );

  server.registerTool(
    "agentpool_v44_opportunities",
    {
      title: "List v4.4 read-only opportunities",
      description:
        "Return public audit materials and the state-preserving opportunity boundary.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(
        await fetchJson(origin, "/api/v4.4/opportunities", fetcher),
      ),
  );

  server.registerTool(
    "agentpool_v44_participation_kit",
    {
      title: "Inspect the v4.4 participation kit",
      description:
        "Return the external audit and compatibility contribution paths.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.4/participate", fetcher)),
  );

  server.registerResource(
    "agentpool-v44-readonly-profile",
    "agentpool://v4.4/read-only-profile",
    {
      title: "AgentPool v4.4 Read-only Profile",
      description:
        "Canonical v4.4 public read-only endpoints and prohibited write capabilities.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              version: AGENTPOOL_V44_PUBLIC_VERSION,
              release: "v4.4",
              mode: "PUBLIC_READ_ONLY_PREVIEW",
              remoteMcp: `${origin}/api/mcp/v4.4`,
              status: `${origin}/api/v4.4/status`,
              opportunities: `${origin}/api/v4.4/opportunities`,
              participation: `${origin}/api/v4.4/participate`,
              capabilityMode: "READ_ONLY_ONLY",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    "inspect_agentpool_v44_readonly",
    {
      title: "Inspect AgentPool v4.4 safely",
      description:
        "Guide an AI through a reproducible public read-only audit.",
    },
    async () => ({
      description: "Inspect AgentPool v4.4 without a chain write.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Inspect AgentPool v4.4 using only agentpool_v44_discovery, agentpool_v44_status, agentpool_v44_opportunities, and agentpool_v44_participation_kit. Perform no state change and report reproducible public evidence only.",
          },
        },
      ],
    }),
  );

  return server;
}
