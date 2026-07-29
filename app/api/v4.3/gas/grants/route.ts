import { env } from "cloudflare:workers";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";
import { execute, queryFirst } from "@/db/runtime";
import { apiResponse, handleApiError } from "@/lib/api";
import {
  V43_GAS_GRANT_CHAIN_ID,
  V43_GAS_GRANT_DAILY_COUNT_CAP,
  V43_GAS_GRANT_DAILY_WEI_CAP,
  V43_GAS_GRANT_MINIMUM_BALANCE_WEI,
  V43_GAS_GRANT_SPONSOR_RESERVE_WEI,
  V43_GAS_GRANT_TARGET_BALANCE_WEI,
  gasGrantAmountWei,
  gasGrantDayBucket,
  validateSignedGasRequest,
} from "@/lib/v43-gas-grant-policy.mjs";
import { signedV43Write } from "@/lib/v43-write";

export const dynamic = "force-dynamic";

const writeSchema = z.object({
  requestEventId: z.string().regex(/^evt:[a-f0-9]{64}$/),
});

interface GasRequestRow {
  id: string;
  actor_address: string;
  body_json: string;
  created_at: number;
  expires_at: number;
}

interface GasGrantRow {
  id: string;
  request_event_id: string;
  recipient_address: string;
  day_bucket: number;
  amount_wei: number;
  balance_before_wei: number;
  status: string;
  tx_hash: string | null;
  block_number: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

function sponsorAccount() {
  const privateKey = env.AGENTPOOL_V43_GAS_SPONSOR_PRIVATE_KEY?.trim();
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/u.test(privateKey)) return null;
  return privateKeyToAccount(privateKey as `0x${string}`);
}

function chainClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org", {
      retryCount: 3,
      timeout: 30_000,
    }),
  });
}

function publicGrant(row: GasGrantRow) {
  return {
    id: row.id,
    requestEventId: row.request_event_id,
    recipientAddress: row.recipient_address,
    chainId: V43_GAS_GRANT_CHAIN_ID,
    testnetOnly: true,
    amountWei: String(row.amount_wei),
    amountEth: formatEther(BigInt(row.amount_wei)),
    balanceBeforeWei: String(row.balance_before_wei),
    status: row.status,
    transactionHash: row.tx_hash,
    blockNumber:
      row.block_number === null ? null : String(row.block_number),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findExistingGrant(
  requestEventId: string,
  recipientAddress: string,
  dayBucket: number,
) {
  return queryFirst<GasGrantRow>(
    `SELECT id, request_event_id, recipient_address, day_bucket,
            amount_wei, balance_before_wei, status, tx_hash,
            block_number, error_code, created_at, updated_at
     FROM v43_gas_grants
     WHERE request_event_id = ?
        OR (recipient_address = ? AND day_bucket = ?)
     LIMIT 1`,
    requestEventId,
    recipientAddress,
    dayBucket,
  );
}

export async function GET(): Promise<Response> {
  try {
    const account = sponsorAccount();
    const now = Date.now();
    const dayBucket = gasGrantDayBucket(now);
    const daily = await queryFirst<{
      grant_count: number;
      amount_wei: number;
    }>(
      `SELECT grant_count, amount_wei
       FROM v43_gas_grant_daily_budgets
       WHERE day_bucket = ?`,
      dayBucket,
    );
    let sponsorBalanceWei: bigint | null = null;
    if (account) {
      sponsorBalanceWei = await chainClient().getBalance({
        address: account.address,
      });
    }
    return apiResponse({
      protocol: "AgentPool",
      release: "v4.3.8-gas-onboarding-alpha",
      chainId: V43_GAS_GRANT_CHAIN_ID,
      testnetOnly: true,
      configured: account !== null,
      sponsorAddress: account?.address ?? null,
      sponsorBalanceWei:
        sponsorBalanceWei === null ? null : sponsorBalanceWei.toString(),
      sponsorBalanceEth:
        sponsorBalanceWei === null ? null : formatEther(sponsorBalanceWei),
      policy: {
        signedGasRequestRequired: true,
        arbitraryTransferAllowed: false,
        grantsPerAddressPerUtcDay: 1,
        minimumBalanceWei:
          V43_GAS_GRANT_MINIMUM_BALANCE_WEI.toString(),
        targetBalanceWei: V43_GAS_GRANT_TARGET_BALANCE_WEI.toString(),
        sponsorReserveWei:
          V43_GAS_GRANT_SPONSOR_RESERVE_WEI.toString(),
        globalDailyGrantCountCap: V43_GAS_GRANT_DAILY_COUNT_CAP,
        globalDailyWeiCap: V43_GAS_GRANT_DAILY_WEI_CAP.toString(),
      },
      today: {
        dayBucket,
        grantCount: daily?.grant_count ?? 0,
        amountWei: String(daily?.amount_wei ?? 0),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return signedV43Write(
    request,
    writeSchema,
    async ({ requestEventId }, auth) => {
      const now = Date.now();
      const normalizedRecipient = auth.address.toLowerCase();
      const dayBucket = gasGrantDayBucket(now);
      const existing = await findExistingGrant(
        requestEventId,
        normalizedRecipient,
        dayBucket,
      );
      if (existing) {
        return {
          body: {
            ok: existing.status === "CONFIRMED",
            duplicateSuppressed: true,
            grant: publicGrant(existing),
          },
          status: existing.status === "CONFIRMED" ? 200 : 202,
        };
      }

      const gasRequest = await queryFirst<GasRequestRow>(
        `SELECT id, actor_address, body_json, created_at, expires_at
         FROM v43_coordination_events
         WHERE id = ? AND event_type = 'GAS_REQUEST'
         LIMIT 1`,
        requestEventId,
      );
      if (!gasRequest || gasRequest.actor_address !== normalizedRecipient) {
        throw new Error("V43_GAS_GRANT_REQUEST_NOT_FOUND");
      }
      validateSignedGasRequest({
        actorAddress: normalizedRecipient,
        body: JSON.parse(gasRequest.body_json),
        createdAt: gasRequest.created_at,
        expiresAt: gasRequest.expires_at,
        now,
      });

      const account = sponsorAccount();
      if (!account) {
        return {
          status: 202,
          body: {
            ok: false,
            state: "PENDING_SPONSOR",
            recoverable: true,
            reason: "TESTNET_GAS_SPONSOR_NOT_CONFIGURED",
            requestEventId,
          },
        };
      }

      const client = chainClient();
      const currentBalanceWei = await client.getBalance({
        address: auth.address,
      });
      const amountWei = gasGrantAmountWei(currentBalanceWei);
      if (amountWei === 0n) {
        return {
          body: {
            ok: true,
            state: "NOT_NEEDED",
            recipientAddress: auth.address,
            currentBalanceWei: currentBalanceWei.toString(),
            minimumBalanceWei:
              V43_GAS_GRANT_MINIMUM_BALANCE_WEI.toString(),
          },
        };
      }
      const sponsorBalanceWei = await client.getBalance({
        address: account.address,
      });
      if (
        sponsorBalanceWei <
        amountWei + V43_GAS_GRANT_SPONSOR_RESERVE_WEI
      ) {
        return {
          status: 202,
          body: {
            ok: false,
            state: "PENDING_SPONSOR_FUNDING",
            recoverable: true,
            requestEventId,
            sponsorAddress: account.address,
          },
        };
      }

      const grantId = `gasgrant:${requestEventId.slice(4)}`;
      try {
        await execute(
          `INSERT INTO v43_gas_grants
            (id, request_event_id, recipient_address, day_bucket, amount_wei,
             balance_before_wei, status, tx_hash, block_number, error_code,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'RESERVED', NULL, NULL, NULL, ?, ?)`,
          grantId,
          requestEventId,
          normalizedRecipient,
          dayBucket,
          Number(amountWei),
          Number(currentBalanceWei),
          now,
          now,
        );
      } catch (error) {
        const concurrent = await findExistingGrant(
          requestEventId,
          normalizedRecipient,
          dayBucket,
        );
        if (!concurrent) throw error;
        return {
          body: {
            ok: concurrent.status === "CONFIRMED",
            duplicateSuppressed: true,
            grant: publicGrant(concurrent),
          },
          status: concurrent.status === "CONFIRMED" ? 200 : 202,
        };
      }
      await execute(
        `INSERT INTO v43_gas_grant_daily_budgets
          (day_bucket, grant_count, amount_wei, updated_at)
         VALUES (?, 0, 0, ?)
         ON CONFLICT(day_bucket) DO NOTHING`,
        dayBucket,
        now,
      );
      const reserved = await execute(
        `UPDATE v43_gas_grant_daily_budgets
         SET grant_count = grant_count + 1,
             amount_wei = amount_wei + ?,
             updated_at = ?
         WHERE day_bucket = ?
           AND grant_count < ?
           AND amount_wei <= ?`,
        Number(amountWei),
        now,
        dayBucket,
        V43_GAS_GRANT_DAILY_COUNT_CAP,
        Number(V43_GAS_GRANT_DAILY_WEI_CAP - amountWei),
      );
      if (!reserved.success || reserved.meta.changes !== 1) {
        await execute(
          `UPDATE v43_gas_grants
           SET status = 'REJECTED_DAILY_LIMIT',
               error_code = 'V43_GAS_GRANT_DAILY_LIMIT',
               updated_at = ?
           WHERE id = ?`,
          Date.now(),
          grantId,
        );
        return {
          status: 429,
          body: {
            ok: false,
            state: "REJECTED_DAILY_LIMIT",
            recoverable: true,
            retryAfterUtcDay: dayBucket + 1,
          },
        };
      }

      const wallet = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(
          env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org",
          { retryCount: 3, timeout: 30_000 },
        ),
      });
      let transactionHash: `0x${string}`;
      try {
        transactionHash = await wallet.sendTransaction({
          account,
          chain: baseSepolia,
          to: auth.address,
          value: amountWei,
        });
      } catch (error) {
        const errorCode =
          error instanceof Error
            ? error.message.slice(0, 240)
            : "V43_GAS_GRANT_BROADCAST_FAILED";
        await execute(
          `UPDATE v43_gas_grants
           SET status = 'FAILED', error_code = ?, updated_at = ?
           WHERE id = ?`,
          errorCode,
          Date.now(),
          grantId,
        );
        return {
          status: 502,
          body: {
            ok: false,
            state: "FAILED",
            recoverable: true,
            errorCode,
          },
        };
      }

      await execute(
        `UPDATE v43_gas_grants
         SET status = 'BROADCAST', tx_hash = ?, updated_at = ?
         WHERE id = ?`,
        transactionHash,
        Date.now(),
        grantId,
      );
      try {
        const receipt = await client.waitForTransactionReceipt({
          hash: transactionHash,
          confirmations: 1,
          timeout: 60_000,
        });
        const confirmed = receipt.status === "success";
        await execute(
          `UPDATE v43_gas_grants
           SET status = ?, block_number = ?, error_code = ?, updated_at = ?
           WHERE id = ?`,
          confirmed ? "CONFIRMED" : "FAILED",
          Number(receipt.blockNumber),
          confirmed ? null : "V43_GAS_GRANT_TRANSACTION_REVERTED",
          Date.now(),
          grantId,
        );
        const stored = await queryFirst<GasGrantRow>(
          `SELECT id, request_event_id, recipient_address, day_bucket,
                  amount_wei, balance_before_wei, status, tx_hash,
                  block_number, error_code, created_at, updated_at
           FROM v43_gas_grants WHERE id = ?`,
          grantId,
        );
        return {
          status: confirmed ? 201 : 502,
          body: {
            ok: confirmed,
            grant: stored ? publicGrant(stored) : null,
          },
        };
      } catch {
        const stored = await queryFirst<GasGrantRow>(
          `SELECT id, request_event_id, recipient_address, day_bucket,
                  amount_wei, balance_before_wei, status, tx_hash,
                  block_number, error_code, created_at, updated_at
           FROM v43_gas_grants WHERE id = ?`,
          grantId,
        );
        return {
          status: 202,
          body: {
            ok: false,
            state: "BROADCAST",
            recoverable: true,
            grant: stored ? publicGrant(stored) : null,
          },
        };
      }
    },
  );
}
