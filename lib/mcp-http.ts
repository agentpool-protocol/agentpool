import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPublicMcpServer } from "@/lib/mcp-public";
import { createV44PublicMcpServer } from "@/lib/mcp-v44";
import { v44ProvenanceHeaders } from "@/lib/v44-provenance";

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
  includeV44Provenance = true,
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
  const response = await transport.handleRequest(request);
  if (!includeV44Provenance) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(v44ProvenanceHeaders())) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleLegacyPublicMcpRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return handlePublicMcpRequest(
    request,
    fetcher,
    createPublicMcpServer,
    false,
  );
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
