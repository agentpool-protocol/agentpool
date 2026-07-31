import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPublicMcpServer } from "@/lib/mcp-public";
import { createV44PublicMcpServer } from "@/lib/mcp-v44";

type ServerFactory = (
  origin: string,
  fetcher: typeof fetch,
) => ReturnType<typeof createPublicMcpServer>;

function originError(request: Request): Response | null {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return null;
  const endpointOrigin = new URL(request.url).origin;
  if (requestOrigin !== endpointOrigin) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Browser-origin MCP requests must be same-origin. Server-side and desktop MCP clients normally omit Origin.",
        },
        id: null,
      },
      { status: 403 },
    );
  }
  return null;
}

export async function handlePublicMcpRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
  createServer: ServerFactory = createV44PublicMcpServer,
): Promise<Response> {
  const rejected = originError(request);
  if (rejected) return rejected;

  const origin = new URL(request.url).origin;
  const server = createServer(origin, fetcher);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function handleLegacyPublicMcpRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return handlePublicMcpRequest(request, fetcher, createPublicMcpServer);
}

export function publicMcpOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "GET, POST, DELETE, OPTIONS",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, accept, mcp-protocol-version, mcp-session-id",
      "access-control-allow-origin":
        "https://agentpool-protocol.asfu.chatgpt.site",
      vary: "Origin",
    },
  });
}
