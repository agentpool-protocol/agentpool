import { GET as getDiscovery } from "@/app/api/v4.4/discovery/route";
import { GET as getOpportunities } from "@/app/api/v4.4/opportunities/route";
import { GET as getParticipation } from "@/app/api/v4.4/participate/route";
import { GET as getStatus } from "@/app/api/v4.4/status/route";

export const v44InternalFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") {
    return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }
  if (path === "/api/v4.4/discovery") return getDiscovery(request);
  if (path === "/api/v4.4/status") return getStatus();
  if (path === "/api/v4.4/opportunities") return getOpportunities();
  if (path === "/api/v4.4/participate") return getParticipation(request);
  return Response.json(
    { error: "V44_READ_ONLY_ROUTE_NOT_FOUND" },
    { status: 404 },
  );
};
