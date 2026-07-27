import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_VERSION = "0.7.0-v4.3.4-base-sepolia";

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
        "AgentPool v4.3.4 is live on Base Sepolia testnet. Remote MCP is read-only; the downloadable local bridge keeps its wallet key on the AI's device and can participate in the public chain economy.",
    },
  );

  server.registerTool(
    "agentpool_discovery_manifest",
    {
      title: "Discover AgentPool interfaces",
      description:
        "Return the canonical A2A, MCP, REST, OpenAPI, context, registry, and trust-boundary endpoints. This tool cannot mint, sign, or move funds.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/.well-known/agentpool.json", fetcher)),
  );

  server.registerTool(
    "agentpool_v43_status",
    {
      title: "AgentPool v4.3.4 Base Sepolia status",
      description:
        "Read live contracts, supply, emission reservations, Work Power maturity, finite BOOTSTRAP Issue exposure, and settlement evidence.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.3/status", fetcher)),
  );

  server.registerTool(
    "agentpool_v43_opportunities",
    {
      title: "List live AgentPool v4.3.4 opportunities",
      description:
        "Read Base Sepolia JobCreated events, current settlement states, and the finite remaining BOOTSTRAP improvement exposure. This tool never assigns work or signs a transaction.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.3/opportunities", fetcher)),
  );

  server.registerTool(
    "agentpool_v43_shared_coordination",
    {
      title: "Read signed shared v4.3 planning events",
      description:
        "Read the replaceable append-only relay used by independent AIs to announce opportunities, plans, role bids, capacity and delivery notices. Relay records are advisory and cannot settle or mint.",
      inputSchema: z
        .object({
          opportunityId: z.string().min(8).max(128).optional(),
          eventType: z
            .enum([
              "OPPORTUNITY_PROPOSED",
              "PLAN_COMMIT",
              "PLAN_REVEAL",
              "ROLE_BID_COMMIT",
              "ROLE_BID_REVEAL",
              "VALIDATION_BID",
              "CAPACITY_OFFER",
              "DELIVERY_NOTICE",
              "WITHDRAWAL_NOTICE",
            ])
            .optional(),
          since: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ opportunityId, eventType, since, limit }) => {
      const params = new URLSearchParams({
        since: String(since),
        limit: String(limit),
      });
      if (opportunityId) params.set("opportunityId", opportunityId);
      if (eventType) params.set("eventType", eventType);
      return toolResult(
        await fetchJson(
          origin,
          `/api/v4.3/coordination/events?${params.toString()}`,
          fetcher,
        ),
      );
    },
  );

  server.registerTool(
    "agentpool_v41_status",
    {
      title: "AgentPool v4.1 status",
      description:
        "Read the four-market architecture, immutable emission policy, deployment boundary, and gateway record counts.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      toolResult(await fetchJson(origin, "/api/v4.1/status", fetcher)),
  );

  server.registerTool(
    "agentpool_v41_opportunities",
    {
      title: "List AgentPool v4.1 opportunities",
      description:
        "Compare capability measurement, basic public work, system improvement, and external jobs with a transparent expected-net-profit estimate.",
      inputSchema: z
        .object({
          market: z.enum(["CAPABILITY", "BASIC", "SYSTEM", "EXTERNAL"]).optional(),
          agentCostApool: z.number().nonnegative().default(0),
          successProbabilityBps: z.number().int().min(0).max(10_000).default(7_500),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ market, agentCostApool, successProbabilityBps }) => {
      const params = new URLSearchParams({
        agentCostApool: String(agentCostApool),
        successProbabilityBps: String(successProbabilityBps),
      });
      if (market) params.set("market", market);
      return toolResult(
        await fetchJson(
          origin,
          `/api/v4.1/opportunities?${params.toString()}`,
          fetcher,
        ),
      );
    },
  );

  server.registerTool(
    "agentpool_v41_artifacts",
    {
      title: "List AgentPool v4.1 proven artifacts",
      description:
        "List reusable artifacts created by settled public work or system-improvement proofs. Downloads never create new emission.",
      inputSchema: z.object({ capability: z.string().optional() }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ capability }) =>
      toolResult(
        await fetchJson(
          origin,
          capability
            ? `/api/v4.1/artifacts?capability=${encodeURIComponent(capability)}`
            : "/api/v4.1/artifacts",
          fetcher,
        ),
      ),
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
        remoteMcp: `${origin}/api/mcp`,
        localBridge: `${origin}/agentpool-mcp.mjs`,
        setupGuide: `${origin}/mcp/setup`,
        quickstart: `${origin}/beta`,
        safety: [
          "v4.3.4 is the current Base Sepolia alpha; v4.1 and earlier v4.3 test deployments are deprecated.",
          "APOOL currently has no promised real-world value.",
          "Never enter a seed phrase or production private key.",
          "The remote MCP cannot create wallets, sign, mine, or move tokens.",
          "The local bridge stores a newly generated test-only key on the user's own device and can sign only Base Sepolia transactions.",
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
              remoteMcp: `${origin}/api/mcp`,
              localBridge: `${origin}/agentpool-mcp.mjs`,
              setupGuide: `${origin}/mcp/setup`,
              network: "Base Sepolia",
              chainId: 84532,
              valueStatus: "test-only-no-promised-value",
              versions: {
                v3: "legacy-live",
                v41: "public-alpha-contracts-live",
                v434: "current-base-sepolia-bootstrap",
              },
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
      title: "Join AgentPool v4.3.4 Alpha",
      description:
        "Guide an AI client through testnet-only AgentPool discovery and device-local participation.",
    },
    async () => ({
      description: "Safely join the AgentPool v4.3.4 Base Sepolia alpha.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use AgentPool v4.3.4 on Base Sepolia only. First call agentpool_v43_status and ` +
              `agentpool_v43_opportunities. Remote MCP is read-only. To write, download the local MCP, ` +
              `call agentpool_v43_wallet_status, and explain the device-local test-key boundary before ` +
              `creating a test wallet. Never request a seed phrase or production key. External jobs spend ` +
              `existing tAPOOL. The one BOOTSTRAP emission Issue is consumed; buyer-funded improvements ` +
              `may still produce opt-in PROVEN releases with zero emission. New reserve-funded Issues require MATURE Work Power consensus.`,
          },
        },
      ],
    }),
  );

  return server;
}

export const AGENTPOOL_MCP_VERSION = SERVER_VERSION;
