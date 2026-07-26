import { apiResponse } from "@/lib/api";

export async function GET(): Promise<Response> {
  return apiResponse({
    deprecated: true,
    replacement: "/api/v2/mining/tracks",
    reason: "Weekly demand-mining epochs were removed. APOOL mining now uses private deterministic benchmarks and immediate 3-of-5 receipts.",
  });
}
