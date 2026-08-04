export const V43_GAS_GRANT_CHAIN_ID = 84_532;
export const V43_GAS_GRANT_MINIMUM_BALANCE_WEI = 1_000_000_000_000n;
export const V43_GAS_GRANT_TARGET_BALANCE_WEI = 3_000_000_000_000n;
export const V43_GAS_GRANT_MAXIMUM_WEI = 3_000_000_000_000n;
export const V43_GAS_GRANT_SPONSOR_RESERVE_WEI = 1_000_000_000_000n;
export const V43_GAS_GRANT_DAILY_COUNT_CAP = 100;
export const V43_GAS_GRANT_DAILY_WEI_CAP = 300_000_000_000_000n;
export const V43_GAS_GRANT_REQUEST_MAX_AGE_MS = 60 * 60 * 1_000;

export function gasGrantDayBucket(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("V43_GAS_GRANT_INVALID_TIME");
  }
  return Math.floor(now / 86_400_000);
}

export function gasGrantAmountWei(currentBalanceWei) {
  if (typeof currentBalanceWei !== "bigint" || currentBalanceWei < 0n) {
    throw new Error("V43_GAS_GRANT_INVALID_BALANCE");
  }
  if (currentBalanceWei >= V43_GAS_GRANT_MINIMUM_BALANCE_WEI) {
    return 0n;
  }
  const required =
    V43_GAS_GRANT_TARGET_BALANCE_WEI - currentBalanceWei;
  return required > V43_GAS_GRANT_MAXIMUM_WEI
    ? V43_GAS_GRANT_MAXIMUM_WEI
    : required;
}

export function validateSignedGasRequest({
  actorAddress,
  body,
  createdAt,
  expiresAt,
  now = Date.now(),
}) {
  const normalizedActor = String(actorAddress).toLowerCase();
  const payload = body?.payload;
  if (
    body?.eventType !== "GAS_REQUEST" ||
    payload?.schema !== "agentpool.gas-request/v1" ||
    Number(payload?.chainId) !== V43_GAS_GRANT_CHAIN_ID ||
    payload?.testnetOnly !== true ||
    String(payload?.recipientAddress).toLowerCase() !== normalizedActor
  ) {
    throw new Error("V43_GAS_GRANT_INVALID_REQUEST");
  }
  if (
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(expiresAt) ||
    createdAt > now ||
    expiresAt <= now ||
    now - createdAt > V43_GAS_GRANT_REQUEST_MAX_AGE_MS
  ) {
    throw new Error("V43_GAS_GRANT_REQUEST_EXPIRED");
  }
  return payload;
}

export function hasDailyGasGrantCapacity({
  grantCount,
  amountWei,
  requestedWei,
}) {
  if (
    !Number.isSafeInteger(grantCount) ||
    grantCount < 0 ||
    typeof amountWei !== "bigint" ||
    amountWei < 0n ||
    typeof requestedWei !== "bigint" ||
    requestedWei <= 0n
  ) {
    throw new Error("V43_GAS_GRANT_INVALID_DAILY_USAGE");
  }
  return (
    grantCount < V43_GAS_GRANT_DAILY_COUNT_CAP &&
    amountWei + requestedWei <= V43_GAS_GRANT_DAILY_WEI_CAP
  );
}
