import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPublicMcpServer } from "@/lib/mcp-public";

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
): Promise<Response> {
  const rejected = originError(request);
  if (rejected) return rejected;

  const origin = new URL(request.url).origin;
  const server = createPublicMcpServer(origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
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
