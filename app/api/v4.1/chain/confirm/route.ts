import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { executeBatch, queryFirst } from "@/db/runtime";
import { requestId } from "@/lib/api";
import {
  type V41EpochAction,
  verifyV41EpochAction,
} from "@/lib/v41-chain-bridge";
import { signedV41Write } from "@/lib/v41-write";

const schema = z.object({
  assignmentId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  action: z.enum(["ACCEPT", "DELIVER", "SETTLE", "EXPIRE"]),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

interface Assignment {
  id: Hex;
  worker_address: string;
  state: string;
  delivery_hash: Hex | null;
  release_id: string;
  capability: string;
}

interface ChainLink {
  vault_address: string;
  state: string;
  accept_tx_hash: string | null;
  deliver_tx_hash: string | null;
  settle_tx_hash: string | null;
  expire_tx_hash: string | null;
}

const transitions: Record<V41EpochAction, {
  from: string[];
  to: string;
  txColumn: string;
  eventType: string;
}> = {
  ACCEPT: {
    from: ["AWARDED"],
    to: "ACCEPTED",
    txColumn: "accept_tx_hash",
    eventType: "V41_ASSIGNMENT_ACCEPTED",
  },
  DELIVER: {
    from: ["ACCEPTED", "RUNNING"],
    to: "DELIVERED",
    txColumn: "deliver_tx_hash",
    eventType: "V41_ASSIGNMENT_DELIVERED",
  },
  SETTLE: {
    from: ["DELIVERED", "PROOF_PENDING"],
    to: "SETTLED",
    txColumn: "settle_tx_hash",
    eventType: "V41_ASSIGNMENT_SETTLED",
  },
  EXPIRE: {
    from: ["AWARDED", "ACCEPTED", "RUNNING", "DELIVERED", "PROOF_PENDING"],
    to: "EXPIRED",
    txColumn: "expire_tx_hash",
    eventType: "V41_ASSIGNMENT_EXPIRED",
  },
};

export async function POST(request: Request): Promise<Response> {
  return signedV41Write(request, schema, async (input, auth) => {
    const [assignment, chainLink] = await Promise.all([
      queryFirst<Assignment>(
        `SELECT a.id, a.worker_address, a.state, a.delivery_hash,
                a.release_id, o.capability
         FROM v41_assignments a
         JOIN v41_opportunities o ON o.id = a.opportunity_id
         WHERE a.id = ?`,
        input.assignmentId,
      ),
      queryFirst<ChainLink>(
        `SELECT vault_address, state, accept_tx_hash, deliver_tx_hash,
                settle_tx_hash, expire_tx_hash
         FROM v41_chain_assignments
         WHERE assignment_id = ? AND chain_id = 84532`,
        input.assignmentId,
      ),
    ]);
    if (!assignment || !chainLink) {
      throw new Error("INVALID_V41_CHAIN_ASSIGNMENT");
    }
    if (assignment.worker_address.toLowerCase() !== auth.address.toLowerCase()) {
      throw new Error("AUTH_ASSIGNMENT_WORKER");
    }
    const transition = transitions[input.action];
    if (!transition.from.includes(assignment.state)) {
      if (assignment.state === transition.to) {
        const storedHash =
          input.action === "ACCEPT"
            ? chainLink.accept_tx_hash
            : input.action === "DELIVER"
              ? chainLink.deliver_tx_hash
              : input.action === "SETTLE"
                ? chainLink.settle_tx_hash
                : chainLink.expire_tx_hash;
        if (!storedHash || storedHash.toLowerCase() !== input.txHash.toLowerCase()) {
          throw new Error("INVALID_V41_CHAIN_REPLAY");
        }
        return {
          body: {
            assignmentId: assignment.id,
            state: assignment.state,
            action: input.action,
            replayed: true,
          },
        };
      }
      throw new Error("INVALID_V41_CHAIN_TRANSITION");
    }
    const evidence = await verifyV41EpochAction({
      txHash: input.txHash as Hex,
      vault: getAddress(chainLink.vault_address),
      assignmentId: assignment.id,
      action: input.action,
      worker: getAddress(assignment.worker_address),
      expectedDeliveryHash:
        input.action === "DELIVER"
          ? assignment.delivery_hash ?? undefined
          : undefined,
    });
    const now = Date.now();
    const assignmentUpdates = [
      "state = ?",
      "updated_at = ?",
    ];
    const assignmentBindings: unknown[] = [transition.to, now];
    if (evidence.deliveryHash) {
      assignmentUpdates.push("delivery_hash = ?");
      assignmentBindings.push(evidence.deliveryHash);
    }
    if (evidence.proofHash) {
      assignmentUpdates.push("proof_hash = ?", "tx_hash = ?");
      assignmentBindings.push(evidence.proofHash, input.txHash);
    }
    assignmentBindings.push(assignment.id);

    const statements = [
      {
        sql: `UPDATE v41_assignments SET ${assignmentUpdates.join(", ")}
              WHERE id = ?`,
        bindings: assignmentBindings,
      },
      {
        sql: `UPDATE v41_chain_assignments
              SET ${transition.txColumn} = ?, last_block = ?, state = ?,
                  updated_at = ?
              WHERE assignment_id = ?`,
        bindings: [
          input.txHash,
          Number(evidence.blockNumber),
          transition.to,
          now,
          assignment.id,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO protocol_events
          (id, type, entity_id, actor_address, payload_json, chain_id,
           block_number, log_index, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 84532, ?, ?, ?, ?)`,
        bindings: [
          requestId(),
          transition.eventType,
          assignment.id,
          auth.address,
          JSON.stringify({
            action: input.action,
            vault: chainLink.vault_address,
            deliveryHash: evidence.deliveryHash,
            proofHash: evidence.proofHash,
          }),
          Number(evidence.blockNumber),
          evidence.logIndex,
          input.txHash,
          now,
        ],
      },
      {
        sql: `INSERT INTO chain_cursors
          (chain_id, last_finalized_block, updated_at)
         VALUES (84532, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_finalized_block =
             MAX(last_finalized_block, excluded.last_finalized_block),
           updated_at = excluded.updated_at`,
        bindings: [Number(evidence.blockNumber), now],
      },
      ...(evidence.artifact && evidence.proofHash
        ? [{
            sql: `INSERT OR IGNORE INTO v41_artifacts
              (id, assignment_id, author_address, content_hash,
               provenance_hash, license_hash, release_id, capability,
               proof_hash, reuse_price_apool, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', 'PROVEN', ?)`,
            bindings: [
              evidence.artifact.id,
              assignment.id,
              evidence.artifact.author,
              evidence.artifact.contentHash,
              evidence.artifact.provenanceHash,
              evidence.artifact.licenseHash,
              assignment.release_id,
              assignment.capability,
              evidence.proofHash,
              now,
            ],
          }]
        : []),
    ];
    await executeBatch(statements);
    return {
      body: {
        assignmentId: assignment.id,
        state: transition.to,
        action: input.action,
        chainId: 84532,
        transactionHash: input.txHash,
        blockNumber: evidence.blockNumber.toString(),
        eventVerified: true,
      },
    };
  });
}
