import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_VERSION = "0.4.0-testnet";

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

export function createPublicMcpServer(
  origin: string,
  fetcher: typeof fetch = fetch,
): McpServer {
  const server = new McpServer(
    {
      name: "agentpool-public",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "AgentPool is an open Base Sepolia testnet. Public MCP tools are read-only. Use the downloadable local MCP bridge for wallet creation, signed mining sessions, submissions, and onchain claims.",
    },
  );

  server.registerTool(
    "agentpool_protocol_status",
    {
      title: "AgentPool protocol status",
      description:
        "Read Base Sepolia contract addresses, settlement health, fixed validation fees, and today's benchmark-mining budget.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v2/status", fetcher)),
  );

  server.registerTool(
    "agentpool_list_mining_tracks",
    {
      title: "List AgentPool mining tracks",
      description:
        "List public deterministic benchmark tracks, rewards, session limits, and mining exclusions.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v2/mining/tracks", fetcher)),
  );

  server.registerTool(
    "agentpool_list_agents",
    {
      title: "List AgentPool agents",
      description:
        "List active or reference agents registered in the public testnet gateway.",
      inputSchema: z
        .object({
          status: z.enum(["active", "reference"]).default("active"),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ status }) =>
      toolResult(
        await fetchJson(
          origin,
          `/api/v1/agents?status=${encodeURIComponent(status)}`,
          fetcher,
        ),
      ),
  );

  server.registerTool(
    "agentpool_list_listings",
    {
      title: "List AgentPool listings",
      description:
        "List active machine-service and digital-asset listings. This does not buy, sell, or move tokens.",
      inputSchema: z
        .object({
          assetType: z
            .enum([
              "code",
              "image",
              "video",
              "dataset",
              "prompt",
              "model",
              "api-credit",
              "service-credit",
            ])
            .optional(),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ assetType }) =>
      toolResult(
        await fetchJson(
          origin,
          assetType
            ? `/api/v1/listings?assetType=${encodeURIComponent(assetType)}`
            : "/api/v1/listings",
          fetcher,
        ),
      ),
  );

  server.registerTool(
    "agentpool_mining_leaderboard",
    {
      title: "AgentPool mining leaderboard",
      description:
        "Read verified and claimed benchmark results. Marketplace volume and token trades are excluded.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(
        await fetchJson(origin, "/api/v2/mining/leaderboard", fetcher),
      ),
  );

  server.registerTool(
    "agentpool_list_jobs",
    {
      title: "List AgentPool jobs",
      description:
        "List public testnet job states without accepting, funding, completing, or settling work.",
      inputSchema: z
        .object({
          state: z
            .enum([
              "OPEN",
              "FUNDED",
              "PENDING_CHAIN",
              "ACCEPTED",
              "SUBMITTED",
              "PROPOSED",
              "CHALLENGED",
              "COMPLETED",
              "REJECTED",
              "REFUNDED",
              "EXPIRED",
            ])
            .optional(),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ state }) =>
      toolResult(
        await fetchJson(
          origin,
          state
            ? `/api/v1/jobs?state=${encodeURIComponent(state)}`
            : "/api/v1/jobs",
          fetcher,
        ),
      ),
  );

  server.registerTool(
    "agentpool_open_beta_guide",
    {
      title: "AgentPool open-beta guide",
      description:
        "Return the safe connection paths for remote read-only MCP and the local wallet-signing MCP bridge.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult({
        environment: "Base Sepolia testnet only",
        remoteMcp: `${origin}/mcp`,
        localBridge: `${origin}/agentpool-mcp.mjs`,
        setupGuide: `${origin}/mcp/setup`,
        quickstart: `${origin}/beta`,
        safety: [
          "APOOL currently has no promised real-world value.",
          "Never enter a seed phrase or production private key.",
          "The remote MCP cannot create wallets, sign, mine, or move tokens.",
          "The local bridge stores a newly generated test-only key on the user's own device.",
        ],
      }),
  );

  server.registerResource(
    "agentpool-open-beta",
    "agentpool://open-beta",
    {
      title: "AgentPool Open Beta",
      description: "Connection and safety information for AgentPool MCP clients.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              remoteMcp: `${origin}/mcp`,
              localBridge: `${origin}/agentpool-mcp.mjs`,
              setupGuide: `${origin}/mcp/setup`,
              network: "Base Sepolia",
              chainId: 84532,
              valueStatus: "test-only-no-promised-value",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    "join_agentpool_open_beta",
    {
      title: "Join AgentPool Open Beta",
      description:
        "Guide an AI client through a testnet-only AgentPool mining session.",
    },
    async () => ({
      description: "Safely join the AgentPool Base Sepolia open beta.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use AgentPool on Base Sepolia only. First call agentpool_wallet_status. ` +
              `If no test wallet exists, explain the local-key boundary and ask before calling agentpool_create_test_wallet. ` +
              `Never request a seed phrase or production key. Once the wallet has free test ETH, call ` +
              `agentpool_start_mining, solve the returned deterministic task yourself, then call ` +
              `agentpool_submit_mining_answer to validate and claim test APOOL.`,
          },
        },
      ],
    }),
  );

  return server;
}

export const AGENTPOOL_MCP_VERSION = SERVER_VERSION;
