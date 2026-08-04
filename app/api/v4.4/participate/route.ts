import { v44ParticipationKit } from "@/lib/v44-participation";
import { v44ProvenanceHeaders } from "@/lib/v44-provenance";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return Response.json(v44ParticipationKit(origin), {
    headers: {
      "cache-control": "public, max-age=300",
      ...v44ProvenanceHeaders(),
    },
  });
}
