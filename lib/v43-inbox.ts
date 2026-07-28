import { queryAll } from "@/db/runtime";
import { getV43Opportunities } from "@/lib/v43-chain";

interface CoordinationRow {
  id: string;
  event_type: string;
  opportunity_id: string;
  actor_address: string;
  parent_event_id: string | null;
  body_json: string;
  request_hash: string;
  created_at: number;
  expires_at: number;
}

interface RelayEvent {
  id: string;
  eventType: string;
  opportunityId: string;
  actorAddress: string;
  parentEventId: string | null;
  payload: Record<string, unknown>;
  requestHash: string;
  createdAt: number;
  expiresAt: number;
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function parseRelayRow(row: CoordinationRow): RelayEvent | null {
  try {
    const envelope = JSON.parse(row.body_json);
    const payload = envelope?.payload;
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      return null;
    }
    return {
      id: row.id,
      eventType: row.event_type,
      opportunityId: row.opportunity_id,
      actorAddress: row.actor_address,
      parentEventId: row.parent_event_id,
      payload,
      requestHash: row.request_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

export async function getV43BuyerInbox(address: string) {
  const buyerAddress = address.toLowerCase();
  const [rows, chain] = await Promise.all([
    queryAll<CoordinationRow>(
      `SELECT id, event_type, opportunity_id, actor_address, parent_event_id,
              body_json, request_hash, created_at, expires_at
       FROM v43_coordination_events
       WHERE event_type IN ('JOB_TERMS', 'RESULT_AVAILABLE', 'SETTLEMENT_RECEIPT')
       ORDER BY created_at DESC, id DESC
       LIMIT 1000`,
    ),
    getV43Opportunities(),
  ]);
  const events = rows
    .map(parseRelayRow)
    .filter((event): event is RelayEvent => event !== null);
  const termEvents = events.filter(
    (event) =>
      event.eventType === "JOB_TERMS" &&
      normalized(event.payload.buyerAddress) === buyerAddress,
  );
  const jobs = termEvents.map((termsEvent) => {
    const jobId = String(termsEvent.payload.jobId ?? "");
    const workerAddress = normalized(termsEvent.payload.workerAddress);
    const resultEvents = events
      .filter(
        (event) =>
          event.eventType === "RESULT_AVAILABLE" &&
          String(event.payload.jobId).toLowerCase() === jobId.toLowerCase(),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    const settlementEvents = events
      .filter(
        (event) =>
          event.eventType === "SETTLEMENT_RECEIPT" &&
          String(event.payload.jobId).toLowerCase() === jobId.toLowerCase(),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    const chainJob = chain.jobs.find(
      (job) =>
        String(job.jobId).toLowerCase() === jobId.toLowerCase(),
    );
    const activity = chain.activity.filter(
      (entry) =>
        normalized((entry.args as Record<string, unknown>)?.jobId) ===
        jobId.toLowerCase(),
    );
    const result = resultEvents.at(-1) ?? null;
    const settlement = settlementEvents.at(-1) ?? null;
    const deliveredOnchain = activity.find(
      (entry) => entry.event === "MilestoneDelivered",
    );
    const settledOnchain = activity.find(
      (entry) => entry.event === "MilestoneSettled",
    );
    return {
      jobId,
      opportunityId: termsEvent.opportunityId,
      buyerAddress,
      workerAddress,
      capability: termsEvent.payload.capability,
      specification: termsEvent.payload.specification,
      task: termsEvent.payload.task,
      expectedDelivery: termsEvent.payload.expectedDelivery,
      payouts: {
        recipients: termsEvent.payload.recipients,
        amountsApool: termsEvent.payload.amountsApool,
        keeperAmountApool: termsEvent.payload.keeperAmountApool,
      },
      chain: {
        state: chainJob?.state ?? "PENDING_CHAIN",
        budgetApool: chainJob?.budgetApool ?? null,
        paidApool: chainJob?.paidApool ?? null,
        creationTransactionHash:
          chainJob?.transactionHash ??
          termsEvent.payload.creationTransactionHash ??
          null,
        deliveryTransactionHash:
          deliveredOnchain?.transactionHash ??
          result?.payload.deliverTransactionHash ??
          null,
        settlementTransactionHash:
          settledOnchain?.transactionHash ??
          settlement?.payload.settlementTransactionHash ??
          null,
      },
      result: result
        ? {
            value: result.payload.result ?? null,
            privateResultEnvelope:
              result.payload.privateResultEnvelope ?? null,
            visibility:
              result.payload.resultVisibility ?? "PUBLIC_TESTNET",
            eventId: result.id,
            actorAddress: result.actorAddress,
            signedByAssignedWorker:
              result.actorAddress.toLowerCase() === workerAddress,
            createdAt: result.createdAt,
          }
        : null,
      settlement: settlement
        ? {
            eventId: settlement.id,
            actorAddress: settlement.actorAddress,
            emissionApool: settlement.payload.emissionApool,
            createdAt: settlement.createdAt,
          }
        : null,
      verification: {
        termsSignedByBuyer:
          termsEvent.actorAddress.toLowerCase() === buyerAddress,
        resultSignedByAssignedWorker:
          result?.actorAddress.toLowerCase() === workerAddress,
        deliveredOnchain: Boolean(deliveredOnchain),
        settledOnchain: Boolean(settledOnchain),
      },
      createdAt: termsEvent.createdAt,
    };
  });
  return {
    protocol: "AgentPool",
    release: "v4.3.5-runner-alpha",
    network: "Base Sepolia",
    chainId: 84532,
    buyerAddress,
    count: jobs.length,
    jobs,
    indexer: chain.indexer,
    privacy:
      "Public results are readable. Private results expose only an HPKE ciphertext envelope and require the buyer's device-local X25519 key.",
  };
}
