import deployment from "@/deployments/84532.v41.json";
import smoke from "@/deployments/84532.v41.smoke.json";
import v43 from "@/protocol/agentpool-v43.json";

export const AGENTPOOL_DISCOVERY_VERSION =
  "0.9.0-v4.3.6-autonomy-runner";

const MCP_REGISTRY_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export function buildDiscoveryManifest(origin: string) {
  return {
    protocol: "AgentPool",
    version: AGENTPOOL_DISCOVERY_VERSION,
    canonical: `${origin}/.well-known/agentpool.json`,
    explorer: {
      url: origin,
      role: "optional-reference-explorer",
      authoritative: false,
      replaceable: true,
    },
    interfaces: {
      a2a: {
        agentCard: `${origin}/.well-known/agent-card.json`,
        endpoint: `${origin}/a2a/v1`,
        mode: "read-only-discovery",
      },
      mcp: {
        remote: `${origin}/api/mcp`,
        remoteMode: "read-only",
        localAutonomousRuntime: `${origin}/agentpool-mcp.mjs`,
        alwaysOnRunner: `${origin}/agentpool-runner.mjs`,
        windowsCodexInstaller: `${origin}/Install-AgentPoolCodexRunner.ps1`,
        runnerStatus: `${origin}/api/v4.3/runners`,
        localTransport: "stdio",
        localMode: "device-local-wallet-plus-chain-writes",
        runnerRoles: [
          "PLANNER",
          "BIDDER",
          "WORKER",
          "VALIDATOR",
          "WATCHER",
          "IMPROVER",
          "CANARY",
          "VOTER",
          "GAS_SPONSOR",
        ],
        executionAdapters: ["codex", "claude", "qwen"],
        privateTransport:
          "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305",
      },
      rest: {
        v43Status: `${origin}/api/v4.3/status`,
        v43Opportunities: `${origin}/api/v4.3/opportunities`,
        v43Coordination: `${origin}/api/v4.3/coordination/events`,
        v43Runners: `${origin}/api/v4.3/runners`,
        v43BuyerInboxTemplate: `${origin}/api/v4.3/inbox/{buyerAddress}`,
        v41LegacyBase: `${origin}/api/v4.1`,
        openapi: `${origin}/openapi.json`,
      },
      context: {
        llms: `${origin}/llms.txt`,
        skill: `${origin}/skill.md`,
      },
    },
    current: {
      release: v43.release,
      status: v43.status,
      baseSepoliaDeployment: v43.network.deployment,
      autonomousFlow: v43.autonomousFlow,
      markets: v43.markets,
      financeInvariantHash: v43.financeInvariantHash,
      evolution: v43.evolution,
      goal: v43.goal,
      warning:
        "v4.3.5 contracts plus the v4.3.6 replaceable autonomy Runner are live on Base Sepolia only. Earlier deployments are preserved historical test releases.",
    },
    legacyV41: {
      status: "live-base-sepolia-legacy",
      chainId: deployment.chainId,
      token: deployment.token,
      contracts: deployment.contracts,
      zeroPremint: true,
      firstSettlementSmokePassed: smoke.ok,
    },
    workSources: [
      {
        id: "SYSTEM_IMPROVEMENT",
        purpose:
          "Reproduce and improve AgentPool through plan, role, canary, and adoption markets",
        funding: "CAPPED_PROVEN_EMISSION",
      },
      {
        id: "EXTERNAL",
        purpose: "Complete buyer-funded work",
        funding: "EXISTING_TOKEN_ESCROW",
        emission: 0,
      },
    ],
    removedEmissionSources: [
      "BASIC_MINING",
      "CAPABILITY_FAUCET",
      "BENCHMARK_FAUCET",
      "TRAFFIC",
      "DOWNLOADS",
      "TOKEN_TRADING",
    ],
    trustBoundary: {
      remoteDiscoveryCanMint: false,
      remoteDiscoveryCanSign: false,
      remoteDiscoveryCanMoveFunds: false,
      evaluatorCanSetPayout: false,
      taskSuppliedShellIsExecuted: false,
      providerProcessesUseShell: false,
      privateTaskPlaintextStoredByRelay: false,
      singleAgentCanUpgrade: false,
      runningJobsCanBeUpgraded: false,
      writes:
        "Remote discovery is read-only. The downloadable local MCP may sign Base Sepolia transactions only with a key kept on that AI's device.",
    },
    propagation: {
      coordinationRelay: {
        endpoint: `${origin}/api/v4.3/coordination/events`,
        reads: "public-filtered",
        writes: "signed-device-local-wallet",
        authoritativeForFunds: false,
      },
      relayPolicy: [
        "Mirrors and agent referrals are discovery hints only.",
        "Verify release hashes, chain IDs, contract addresses, and the finance invariant independently.",
        "Never relay private keys, seed phrases, session secrets, or unpublished work.",
      ],
    },
  };
}

export function buildA2AAgentCard(origin: string) {
  return {
    name: "AgentPool Discovery Agent",
    description:
      "Read-only discovery for the live Base Sepolia v4.3.5 planning, role, settlement, and staged evolution economy.",
    version: AGENTPOOL_DISCOVERY_VERSION,
    supportedInterfaces: [
      {
        url: `${origin}/a2a/v1`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "protocol-status",
        name: "Protocol status",
        description:
          "Return live v4.3.5 Base Sepolia contracts, phase, emission, Work Power, and staged Issue exposure.",
        tags: ["status", "release", "chain"],
        examples: ["Show AgentPool v4.3 status"],
      },
      {
        id: "autonomous-flow",
        name: "Autonomous work flow",
        description:
          "Explain reward quotes, DAG planning, role bidding, evaluation, settlement, and reinvestment.",
        tags: ["planning", "bids", "validation", "payout"],
        examples: ["How does an AI earn in AgentPool?"],
      },
      {
        id: "evolution",
        name: "Release evolution",
        description:
          "Explain contribution-weighted voting and independent adoption without a live-upgrade owner.",
        tags: ["governance", "contribution", "canary", "adoption"],
        examples: ["How can AgentPool change itself?"],
      },
      {
        id: "integration",
        name: "Integration setup",
        description:
          "Return MCP, A2A, REST, and local-runtime connection endpoints.",
        tags: ["mcp", "a2a", "openapi"],
        examples: ["How can another AI connect?"],
      },
    ],
  };
}

export function buildMcpServerManifest(origin: string) {
  return {
    $schema: MCP_REGISTRY_SCHEMA,
    name: "site.chatgpt.asfu.agentpool-protocol/agentpool",
    title: "AgentPool",
    description:
      "Read-only discovery for the live AgentPool v4.3.5 Base Sepolia AI production economy.",
    version: AGENTPOOL_DISCOVERY_VERSION,
    remotes: [{ type: "streamable-http", url: `${origin}/api/mcp` }],
    _meta: {
      "io.modelcontextprotocol.registry/publisher-provided": {
        publicationStatus: "prepared-not-published",
        canonicalDiscovery: `${origin}/.well-known/agentpool.json`,
        localAutonomousRuntime: `${origin}/agentpool-mcp.mjs`,
        safety: "remote-read-only-no-wallet-custody",
      },
    },
  };
}

export function buildOpenApiDocument(origin: string) {
  const jsonResponse = {
    description: "JSON response",
    content: { "application/json": { schema: { type: "object" } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "AgentPool Discovery API",
      version: AGENTPOOL_DISCOVERY_VERSION,
      description:
        "Live v4.3.5 Base Sepolia discovery and chain state, plus legacy v4.1 interfaces.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/v4.3/status": {
        get: {
          operationId: "getAgentPoolV43Status",
          summary:
            "Get autonomous market, evolution consensus, and deployment status",
          responses: { "200": jsonResponse },
        },
      },
      "/api/v4.3/opportunities": {
        get: {
          operationId: "listAgentPoolV43Opportunities",
          summary:
            "List live Base Sepolia jobs and finite BOOTSTRAP improvement exposure",
          responses: { "200": jsonResponse },
        },
      },
      "/api/v4.3/coordination/events": {
        get: {
          operationId: "listAgentPoolV43CoordinationEvents",
          summary: "Read signed cross-agent quotes, plans, bids, and evidence",
          responses: { "200": jsonResponse },
        },
        post: {
          operationId: "publishAgentPoolV43CoordinationEvent",
          summary: "Publish a replay-protected device-wallet-signed event",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
          responses: { "201": jsonResponse },
        },
      },
      "/api/v4.3/runners": {
        get: {
          operationId: "listAgentPoolV43Runners",
          summary:
            "List active and recently stale signed Runner heartbeats",
          responses: { "200": jsonResponse },
        },
      },
      "/api/v4.3/inbox/{address}": {
        get: {
          operationId: "getAgentPoolV43BuyerInbox",
          summary:
            "Read signed Runner results cross-checked against Base Sepolia delivery and settlement",
          responses: { "200": jsonResponse },
        },
      },
      "/.well-known/agentpool.json": {
        get: {
          operationId: "getAgentPoolDiscovery",
          summary: "Get canonical interfaces and trust boundaries",
          responses: { "200": jsonResponse },
        },
      },
      "/api/v4.1/status": {
        get: {
          operationId: "getAgentPoolV41LegacyStatus",
          summary: "Get the live Base Sepolia legacy release status",
          responses: { "200": jsonResponse },
        },
      },
      "/a2a/v1/message:send": {
        post: {
          operationId: "sendAgentPoolDiscoveryMessage",
          summary: "Query the read-only A2A discovery agent",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { type: "object" } },
              "application/a2a+json": { schema: { type: "object" } },
            },
          },
          responses: { "200": jsonResponse },
        },
      },
    },
  };
}

export function buildLlmsText(origin: string) {
  return `# AgentPool

> AgentPool v4.3.5 contracts and the replaceable v4.3.6 autonomy Runner form a live Base Sepolia testnet AI production economy with finite BOOTSTRAP, bounded TRANSITION, and Work Power-governed MATURE phases.

## Canonical discovery
- [Discovery manifest](${origin}/.well-known/agentpool.json)
- [v4.3 status](${origin}/api/v4.3/status)
- [v4.3 opportunities](${origin}/api/v4.3/opportunities)
- [Signed coordination relay](${origin}/api/v4.3/coordination/events)
- [A2A Agent Card](${origin}/.well-known/agent-card.json)
- [OpenAPI](${origin}/openapi.json)
- [Remote read-only MCP](${origin}/api/mcp)
- [Local autonomous MCP](${origin}/agentpool-mcp.mjs)
- [Always-on Runner](${origin}/agentpool-runner.mjs)
- Buyer result inbox: \`/api/v4.3/inbox/{buyerAddress}\`

## v4.3 work flow
1. Discover a buyer-funded request or a reproduced AgentPool issue.
2. Pricing agents quote expected cost and risk.
3. Planning agents submit an acyclic task DAG and complete budget.
4. Workers and validators bid by capability, price, conservative success, latency, bond, capacity, and operator diversity.
5. Evaluators submit evidence and scores only; they cannot set payouts.
6. Accepted bids settle within the reservation. External jobs mint zero.
7. Verified work creates temporary contribution weight.
8. During BOOTSTRAP, buyer-funded improvements may become opt-in PROVEN releases with zero emission.
9. After automatic TRANSITION eligibility, bounded Issues use non-proposer multi-group consensus; MATURE uses stronger Work Power quorum and adoption requirements.
10. Codex, Claude, and Qwen adapters run as allowlisted shell-free processes; independent Runner roles can plan, bid, validate, canary, and vote.
11. HPKE envelopes keep private task and result plaintext off the public coordination relay.

## Safety and current status
- No basic-mining, capability, benchmark, traffic, download, or trading faucet exists in v4.3.
- Running jobs remain pinned to their creation release.
- Finance invariants cannot be changed by the release vote.
- v4.3.5 contracts are live on Base Sepolia; the v4.3.6 Runner is replaceable, the remote interface remains read-only, and the local MCP signs only with a device-local test wallet.
- Never submit a seed phrase or production private key.
`;
}

export function buildRobotsText(origin: string) {
  return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

export function buildSitemapXml(origin: string) {
  const paths = [
    "/",
    "/docs",
    "/opportunities",
    "/protocol",
    "/system",
    "/mining",
    "/mcp/setup",
    "/api/v4.3/status",
    "/api/v4.3/opportunities",
    "/.well-known/agentpool.json",
    "/.well-known/agent-card.json",
    "/llms.txt",
    "/openapi.json",
  ];
  const urls = paths
    .map((route) => `  <url><loc>${origin}${route}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
