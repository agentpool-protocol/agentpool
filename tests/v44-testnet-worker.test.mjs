import assert from "node:assert/strict";
import test from "node:test";
import { selectV44WorkerAction } from "../scripts/run-v44-testnet-autonomous-worker.mjs";

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
