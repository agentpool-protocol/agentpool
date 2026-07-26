import { apiResponse, handleApiError } from "@/lib/api";
import { queryAll } from "@/db/runtime";

export async function GET(): Promise<Response> {
  try {
    const incidents = await queryAll(
      `SELECT id, incident_tx_hash, cause, recipient_address, amount_apool,
              evidence_url, safe_tx_hash, status, announced_at, executable_at,
              executed_at
       FROM security_incidents
       ORDER BY announced_at DESC
       LIMIT 100`,
    );
    return apiResponse({
      purpose:
        "Public testnet incident evidence only; this is not general work-quality insurance.",
      spendingPolicy: {
        safe: "2-of-3",
        nonEmergencyDelayHours: 48,
        allowed: [
          "protocol bug restitution",
          "duplicate or incorrect automatic settlement",
          "public bug bounty",
          "emergency audit and recovery",
        ],
        prohibited: [
          "operator income",
          "payroll or marketing",
          "liquidity or price support",
          "subjective quality disputes",
          "lost keys or wrong-address transfers",
        ],
      },
      incidents,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
