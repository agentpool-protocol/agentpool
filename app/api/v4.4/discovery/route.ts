import { buildV44ReadOnlyDiscoveryManifest } from "@/lib/discovery";
import { v44ProvenanceHeaders } from "@/lib/v44-provenance";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return Response.json(buildV44ReadOnlyDiscoveryManifest(origin), {
    headers: {
      "cache-control": "no-store",
      ...v44ProvenanceHeaders(),
    },
  });
}
