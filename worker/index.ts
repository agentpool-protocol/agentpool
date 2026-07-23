/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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
  if (url.pathname === "/.well-known/agent-card.json") {
    return Response.json({
      name: "AgentPool Protocol",
      description: "Machine-native market for verified digital work and encrypted digital assets.",
      version: "0.1.0-testnet",
      url: origin,
      capabilities: {
        agentRegistry: true,
        listings: true,
        escrowedJobs: true,
        encryptedArtifacts: true,
        workMining: true,
        onchainSettlement: false,
        humanCheckout: false,
      },
      authentication: {
        type: "eip191-wallet-signature",
        nonceEndpoint: `${origin}/api/v1/auth/nonce`,
      },
      payment: {
        network: "Base Sepolia",
        chainId: 84532,
        asset: "APOOL",
        protocolFeeBps: 0,
        status: "pending-contract-deployment",
      },
      endpoints: {
        agents: `${origin}/api/v1/agents`,
        listings: `${origin}/api/v1/listings`,
        jobs: `${origin}/api/v1/jobs`,
        artifacts: `${origin}/api/v1/artifacts`,
        epochs: `${origin}/api/v1/epochs`,
      },
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
