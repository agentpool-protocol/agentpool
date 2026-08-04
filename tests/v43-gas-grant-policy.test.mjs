import assert from "node:assert/strict";
import test from "node:test";
import {
  V43_GAS_GRANT_DAILY_COUNT_CAP,
  V43_GAS_GRANT_DAILY_WEI_CAP,
  V43_GAS_GRANT_MINIMUM_BALANCE_WEI,
  V43_GAS_GRANT_TARGET_BALANCE_WEI,
  gasGrantAmountWei,
  gasGrantDayBucket,
  hasDailyGasGrantCapacity,
  validateSignedGasRequest,
} from "../lib/v43-gas-grant-policy.mjs";

const actor = "0x1111111111111111111111111111111111111111";
const now = 1_800_000_000_000;

function signedRequest(overrides = {}) {
  return {
    actorAddress: actor,
    body: {
      eventType: "GAS_REQUEST",
      payload: {
        schema: "agentpool.gas-request/v1",
        chainId: 84532,
        recipientAddress: actor,
        testnetOnly: true,
      },
    },
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    now,
    ...overrides,
  };
}

test("gas grant tops only an underfunded wallet up to the fixed target", () => {
  assert.equal(gasGrantAmountWei(0n), V43_GAS_GRANT_TARGET_BALANCE_WEI);
  assert.equal(
    gasGrantAmountWei(500_000_000_000n),
    V43_GAS_GRANT_TARGET_BALANCE_WEI - 500_000_000_000n,
  );
  assert.equal(
    gasGrantAmountWei(V43_GAS_GRANT_MINIMUM_BALANCE_WEI),
    0n,
  );
});

test("signed gas requests cannot redirect a grant or cross networks", () => {
  assert.equal(
    validateSignedGasRequest(signedRequest()).recipientAddress,
    actor,
  );
  assert.throws(
    () =>
      validateSignedGasRequest(
        signedRequest({
          body: {
            eventType: "GAS_REQUEST",
            payload: {
              schema: "agentpool.gas-request/v1",
              chainId: 84532,
              recipientAddress:
                "0x2222222222222222222222222222222222222222",
              testnetOnly: true,
            },
          },
        }),
      ),
    /V43_GAS_GRANT_INVALID_REQUEST/,
  );
  assert.throws(
    () =>
      validateSignedGasRequest(
        signedRequest({
          body: {
            eventType: "GAS_REQUEST",
            payload: {
              schema: "agentpool.gas-request/v1",
              chainId: 8453,
              recipientAddress: actor,
              testnetOnly: false,
            },
          },
        }),
      ),
    /V43_GAS_GRANT_INVALID_REQUEST/,
  );
});

test("expired and replay-aged requests are rejected", () => {
  assert.throws(
    () => validateSignedGasRequest(signedRequest({ expiresAt: now })),
    /V43_GAS_GRANT_REQUEST_EXPIRED/,
  );
  assert.throws(
    () =>
      validateSignedGasRequest(
        signedRequest({ createdAt: now - 60 * 60 * 1_000 - 1 }),
      ),
    /V43_GAS_GRANT_REQUEST_EXPIRED/,
  );
});

test("daily global count and wei caps fail closed", () => {
  assert.equal(
    hasDailyGasGrantCapacity({
      grantCount: V43_GAS_GRANT_DAILY_COUNT_CAP - 1,
      amountWei: V43_GAS_GRANT_DAILY_WEI_CAP - 1n,
      requestedWei: 1n,
    }),
    true,
  );
  assert.equal(
    hasDailyGasGrantCapacity({
      grantCount: V43_GAS_GRANT_DAILY_COUNT_CAP,
      amountWei: 0n,
      requestedWei: 1n,
    }),
    false,
  );
  assert.equal(
    hasDailyGasGrantCapacity({
      grantCount: 0,
      amountWei: V43_GAS_GRANT_DAILY_WEI_CAP,
      requestedWei: 1n,
    }),
    false,
  );
  assert.equal(gasGrantDayBucket(86_400_000), 1);
});
