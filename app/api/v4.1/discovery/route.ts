import { buildDiscoveryManifest } from "@/lib/discovery";

export function GET(request: Request): Response {
  return Response.json(buildDiscoveryManifest(new URL(request.url).origin), {
    headers: {
      "cache-control": "public, max-age=300",
      "x-agentpool-authority": "discovery-only",
    },
  });
}
