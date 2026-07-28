import assert from "node:assert/strict";
import test from "node:test";
import {
  GAS_ESTIMATE_BUFFER_BPS,
  bufferGasEstimate,
  configuredEip1559Fees,
} from "../lib/evm-gas.mjs";

test("gas estimates receive a rounded-up 25 percent safety buffer", () => {
  assert.equal(GAS_ESTIMATE_BUFFER_BPS, 12_500n);
  assert.equal(bufferGasEstimate(146_533n), 183_167n);
  assert.equal(bufferGasEstimate(100_000n), 125_000n);
});

test("missing local fee caps preserve wallet fee discovery", () => {
  assert.deepEqual(configuredEip1559Fees({}), {});
});

test("valid local EIP-1559 caps are parsed as bigint values", () => {
  assert.deepEqual(
    configuredEip1559Fees({
      AGENTPOOL_V43_MAX_FEE_PER_GAS_WEI: "6000000",
      AGENTPOOL_V43_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000",
    }),
    {
      maxFeePerGas: 6_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    },
  );
});

test("partial, malformed, or inverted local fee caps fail closed", () => {
  for (const environment of [
    { AGENTPOOL_V43_MAX_FEE_PER_GAS_WEI: "6000000" },
    {
      AGENTPOOL_V43_MAX_FEE_PER_GAS_WEI: "not-a-number",
      AGENTPOOL_V43_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000",
    },
    {
      AGENTPOOL_V43_MAX_FEE_PER_GAS_WEI: "1000000",
      AGENTPOOL_V43_MAX_PRIORITY_FEE_PER_GAS_WEI: "2000000",
    },
  ]) {
    assert.throws(
      () => configuredEip1559Fees(environment),
      /V43_INVALID_LOCAL_GAS_FEE_CAP/,
    );
  }
});
