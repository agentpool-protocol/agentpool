import { queryAll } from "@/db/runtime";
import { apiResponse, handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

interface HeartbeatRow {
  actor_address: string;
  body_json: string;
  created_at: number;
  expires_at: number;
}

interface HeartbeatPayload {
  schema?: unknown;
  chainId?: unknown;
  testnetOnly?: unknown;
  runtime?: unknown;
  operatorGroup?: unknown;
  roles?: unknown;
  capabilities?: unknown;
  privateChannelPublicKey?: unknown;
  metrics?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function heartbeatPayload(bodyJson: string): HeartbeatPayload {
  const envelope = JSON.parse(bodyJson) as {
    payload?: HeartbeatPayload;
  };
  return envelope.payload ?? {};
}

export async function GET(): Promise<Response> {
  try {
    const now = Date.now();
    const rows = await queryAll<HeartbeatRow>(
      `SELECT actor_address, body_json, created_at, expires_at
       FROM v43_coordination_events
       WHERE event_type = ? AND created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
      "RUNNER_HEARTBEAT",
      now - 24 * 60 * 60 * 1_000,
    );
    const latest = new Map<string, HeartbeatRow>();
    for (const row of rows) {
      const address = row.actor_address.toLowerCase();
      if (!latest.has(address)) latest.set(address, row);
    }
    const runners = [...latest.entries()].map(([address, row]) => {
      const payload = heartbeatPayload(row.body_json);
      const active = row.expires_at > now;
      return {
        address,
        status: active ? "ACTIVE" : "STALE",
        chainId: payload.chainId === 84532 ? 84532 : null,
        testnetOnly: payload.testnetOnly === true,
        runtime:
          typeof payload.runtime === "string" ? payload.runtime : null,
        operatorGroup:
          typeof payload.operatorGroup === "string"
            ? payload.operatorGroup
            : null,
        roles: strings(payload.roles),
        capabilities: strings(payload.capabilities),
        privateChannelPublicKey:
          typeof payload.privateChannelPublicKey === "string"
            ? payload.privateChannelPublicKey
            : null,
        metrics:
          payload.metrics &&
          typeof payload.metrics === "object" &&
          !Array.isArray(payload.metrics)
            ? payload.metrics
            : {},
        lastHeartbeatAt: row.created_at,
        expiresAt: row.expires_at,
      };
    });
    return apiResponse({
      protocol: "AgentPool",
      release: "v4.3.6-codex-runner-alpha",
      chainId: 84532,
      testnetOnly: true,
      authoritativeSettlement: false,
      activeCount: runners.filter((runner) => runner.status === "ACTIVE")
        .length,
      staleCount: runners.filter((runner) => runner.status === "STALE")
        .length,
      runners,
      note:
        "Heartbeat presence is operational evidence, not proof that operator groups are independent.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
