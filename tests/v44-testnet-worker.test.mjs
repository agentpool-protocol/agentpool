import assert from "node:assert/strict";
import test from "node:test";
import {
  runV44WorkerCycle,
  selectV44WorkerAction,
} from "../scripts/run-v44-testnet-autonomous-worker.mjs";

function job(jobId, milestones) {
  return { jobId, state: 1, milestones };
}

test("v4.4 worker chooses the highest positive live allocation", () => {
  const selected = selectV44WorkerAction(
    [
      job("0x02", [
        { index: 0, state: 1, deadline: 2_000, allocationTapool: "3" },
      ]),
      job("0x01", [
        { index: 0, state: 2, deadline: 1_500, allocationTapool: "4" },
      ]),
    ],
    1_000,
  );
  assert.equal(selected.jobId, "0x01");
  assert.equal(selected.state, 2);
  assert.equal(selected.allocationTapool, "4");
});

test("v4.4 worker rejects expired, zero-pay, and non-actionable milestones", () => {
  const selected = selectV44WorkerAction(
    [
      job("0x01", [
        { index: 0, state: 1, deadline: 999, allocationTapool: "10" },
        { index: 1, state: 1, deadline: 2_000, allocationTapool: "0" },
        { index: 2, state: 3, deadline: 2_000, allocationTapool: "10" },
      ]),
    ],
    1_000,
  );
  assert.equal(selected, null);
});

test("v4.4 worker never writes before reliability admission", async () => {
  const previousWorker = process.env.V44_BOOTSTRAP_WORKER;
  const address = "0x1000000000000000000000000000000000000000";
  process.env.V44_BOOTSTRAP_WORKER = address;
  let accepted = 0;
  try {
    const outcome = await runV44WorkerCycle(
      {
        account: { address },
        status: async () => ({
          registered: true,
          secondsUntilGenesis: 0,
          latestTimestamp: 1_000,
        }),
        opportunities: async () => [
          job("0x01", [
            {
              index: 0,
              state: 1,
              deadline: 2_000,
              allocationTapool: "4",
            },
          ]),
        ],
        accept: async () => {
          accepted += 1;
          return {};
        },
      },
      1_000,
      async () => {
        throw new Error("V44_BOOTSTRAP_ADMISSION_OBSERVERS_NOT_ACTIVE");
      },
    );
    assert.equal(outcome.state, "WAITING_FOR_RELIABILITY_ADMISSION");
    assert.equal(
      outcome.reason,
      "V44_BOOTSTRAP_ADMISSION_OBSERVERS_NOT_ACTIVE",
    );
    assert.equal(accepted, 0);
  } finally {
    if (previousWorker === undefined) delete process.env.V44_BOOTSTRAP_WORKER;
    else process.env.V44_BOOTSTRAP_WORKER = previousWorker;
  }
});
