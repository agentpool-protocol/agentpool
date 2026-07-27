/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handlePublicMcpRequest,
  publicMcpOptions,
} from "@/lib/mcp-http";
import { handleA2ADiscoveryRequest } from "@/lib/a2a-discovery";
import {
  buildA2AAgentCard,
  buildDiscoveryManifest,
  buildLlmsText,
  buildMcpServerManifest,
  buildOpenApiDocument,
  buildRobotsText,
  buildSitemapXml,
} from "@/lib/discovery";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function discoveryResponse(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = url.origin;
  if (
    url.pathname === "/.well-known/agent-card.json" ||
    url.pathname === "/.well-known/agent.json"
  ) {
    const headers =
      url.pathname === "/.well-known/agent.json"
        ? { deprecation: "true", link: '</.well-known/agent-card.json>; rel="successor-version"' }
        : undefined;
    return Response.json(buildA2AAgentCard(origin), { headers });
  }
  if (url.pathname === "/.well-known/agentpool.json") {
    return Response.json(buildDiscoveryManifest(origin), {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  if (url.pathname === "/server.json") {
    return Response.json(buildMcpServerManifest(origin), {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  if (url.pathname === "/openapi.json") {
    return Response.json(buildOpenApiDocument(origin), {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  if (url.pathname === "/llms.txt") {
    return new Response(buildLlmsText(origin), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (url.pathname === "/robots.txt") {
    return new Response(buildRobotsText(origin), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (url.pathname === "/sitemap.xml") {
    return new Response(buildSitemapXml(origin), {
      headers: { "content-type": "application/xml; charset=utf-8" },
    });
  }
  if (url.pathname === "/.well-known/ucp") {
    return Response.json({
      ucp: "2026-01-11",
      merchant: { name: "AgentPool Protocol", humanCheckout: false },
      services: {
        discovery: `${origin}/api/v1/listings`,
        order: `${origin}/api/v1/jobs`,
        fulfillment: `${origin}/api/v1/artifacts`,
      },
      extensions: [
        "dev.agentpool.wallet-signature",
        "dev.agentpool.hpke-delivery",
        "dev.agentpool.verified-work",
        "dev.agentpool.reward-quote-market-v4.3",
        "dev.agentpool.multi-agent-dag-v4.3",
        "dev.agentpool.role-auction-v4.3",
        "dev.agentpool.proof-of-contribution-v4.3",
        "dev.agentpool.release-adoption-v4.3",
      ],
    });
  }
  return null;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const discovery = discoveryResponse(request);
    if (discovery) return discovery;
    if (
      url.pathname === "/a2a/v1" ||
      url.pathname === "/a2a/v1/message:send"
    ) {
      return handleA2ADiscoveryRequest(
        request,
        (input, init) => {
          const internalRequest =
            input instanceof Request ? input : new Request(input, init);
          return handler.fetch(internalRequest, env, ctx);
        },
      );
    }
    if (url.pathname === "/api/mcp") {
      return request.method === "OPTIONS"
        ? publicMcpOptions()
        : handlePublicMcpRequest(
            request,
            (input, init) => {
              const internalRequest =
                input instanceof Request ? input : new Request(input, init);
              return handler.fetch(internalRequest, env, ctx);
            },
          );
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
