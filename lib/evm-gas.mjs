export const GAS_ESTIMATE_BUFFER_BPS = 12_500n;
const BPS_DENOMINATOR = 10_000n;

export function bufferGasEstimate(
  estimatedGas,
  bufferBps = GAS_ESTIMATE_BUFFER_BPS,
) {
  if (
    typeof estimatedGas !== "bigint" ||
    estimatedGas <= 0n ||
    typeof bufferBps !== "bigint" ||
    bufferBps < BPS_DENOMINATOR
  ) {
    throw new Error("V43_INVALID_GAS_ESTIMATE");
  }
  return (
    (estimatedGas * bufferBps + BPS_DENOMINATOR - 1n) /
    BPS_DENOMINATOR
  );
}

export function configuredEip1559Fees(environment = process.env) {
  const maxFeeRaw = environment.AGENTPOOL_V43_MAX_FEE_PER_GAS_WEI;
  const priorityFeeRaw =
    environment.AGENTPOOL_V43_MAX_PRIORITY_FEE_PER_GAS_WEI;
  if (!maxFeeRaw && !priorityFeeRaw) return {};

  let maxFeePerGas;
  let maxPriorityFeePerGas;
  try {
    maxFeePerGas = BigInt(maxFeeRaw);
    maxPriorityFeePerGas = BigInt(priorityFeeRaw);
  } catch {
    throw new Error("V43_INVALID_LOCAL_GAS_FEE_CAP");
  }
  if (
    maxFeePerGas <= 0n ||
    maxPriorityFeePerGas < 0n ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("V43_INVALID_LOCAL_GAS_FEE_CAP");
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}
