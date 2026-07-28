import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNNER_TASK_SCHEMA,
  canonicalJson,
  executeBuiltinTask,
  newRunnerState,
  runRunnerCycle,
  shouldAcceptTerms,
} from "../runner/agentpool-runner-core.mjs";

const worker = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const validator = "0x3333333333333333333333333333333333333333";

function terms(overrides = {}) {
  return {
    schema: "agentpool.runner.terms/v1",
    chainId: 84532,
    jobId: `0x${"ab".repeat(32)}`,
    milestone: 0,
    buyerAddress: buyer,
    workerAddress: worker,
    validatorAddress: validator,
    capability: "mcp-json-data-code-low-risk",
    task: {
      schema: RUNNER_TASK_SCHEMA,
      kind: "JSON_CANONICALIZE",
      input: { b: 2, a: 1 },
    },
    expectedDelivery: '{"a":1,"b":2}',
    proofMode: "OBJECTIVE_HASH_V1",
    proofText: "objective-proof",
    recipients: [worker, validator],
    amountsApool: ["1", "0.01"],
    workerAmountApool: "1",
    validatorAmountApool: "0.01",
    keeperAmountApool: "0.01",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function event(payload = terms()) {
  return {
    id: "evt:runner-test-0001",
    eventType: "JOB_TERMS",
    opportunityId: "job:runner-test-0001",
    actorAddress: buyer,
    createdAt: 1000,
    body: { payload },
  };
}

function fakeMcp(events = [event()]) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v43_wallet_status") {
        return {
          configured: true,
          address: worker,
          testnetOnly: true,
        };
      }
      if (name === "agentpool_v43_shared_coordination") {
        return {
          events: events.filter(
            (item) => item.createdAt >= Number(args.since ?? 0),
          ),
        };
      }
      if (name === "agentpool_v43_publish_coordination") {
        return { id: `evt:${calls.length}` };
      }
      return {
        transactionHash: `0x${String(calls.length).padStart(64, "0")}`,
      };
    },
  };
}

test("built-in objective tasks are deterministic and never execute code", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(
    executeBuiltinTask({
      schema: RUNNER_TASK_SCHEMA,
      kind: "JSON_SUM",
      values: [1, 2, 3.5],
    }),
    '{"sum":6.5}',
  );
  assert.throws(
    () =>
      executeBuiltinTask({
        schema: RUNNER_TASK_SCHEMA,
        kind: "SHELL",
        command: "anything",
      }),
    /RUNNER_TASK_ADAPTER_REQUIRED/,
  );
});

test("profit and assignment gates reject the wrong worker and loss-making work", () => {
  assert.equal(
    shouldAcceptTerms(
      terms({ workerAddress: buyer }),
      worker,
      { minNetProfitApool: "0" },
    ).reason,
    "NOT_ASSIGNED_WORKER",
  );
  assert.equal(
    shouldAcceptTerms(terms(), worker, {
      minNetProfitApool: "2",
      estimatedCostApool: "0",
      estimatedGasApool: "0",
    }).reason,
    "BELOW_MIN_NET_PROFIT",
  );
});

test("one Runner cycle autonomously accepts, executes, delivers and settles", async () => {
  const mcp = fakeMcp();
  const state = newRunnerState();
  const result = await runRunnerCycle({
    config: {
      capabilities: ["mcp-json-data-code-low-risk"],
      minNetProfitApool: "0.1",
      estimatedCostApool: "0.01",
      estimatedGasApool: "0.01",
      autoResolveObjective: true,
    },
    mcp,
    state,
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].status, "settled");
  assert.equal(
    result.state.jobs[terms().jobId].result,
    '{"a":1,"b":2}',
  );
  assert.deepEqual(
    mcp.calls.map((call) => call.name),
    [
      "agentpool_v43_wallet_status",
      "agentpool_v43_shared_coordination",
      "agentpool_v43_accept_milestone_onchain",
      "agentpool_v43_deliver_milestone_onchain",
      "agentpool_v43_publish_coordination",
      "agentpool_v43_resolve_milestone_onchain",
      "agentpool_v43_publish_coordination",
    ],
  );
  const resultNotice = JSON.parse(
    mcp.calls[4].args.payloadJson,
  );
  assert.equal(resultNotice.result, '{"a":1,"b":2}');
  assert.equal(resultNotice.workerAddress, worker);

  const second = await runRunnerCycle({
    config: { autoResolveObjective: true },
    mcp,
    state: result.state,
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.equal(second.outcomes.length, 0);
  assert.equal(
    mcp.calls.filter(
      (call) =>
        call.name === "agentpool_v43_deliver_milestone_onchain",
    ).length,
    1,
  );
});

test("a result differing from the buyer commitment is never delivered", async () => {
  const badEvent = event(
    terms({ expectedDelivery: '{"a":1,"b":999}' }),
  );
  const mcp = fakeMcp([badEvent]);
  const result = await runRunnerCycle({
    config: {
      capabilities: ["mcp-json-data-code-low-risk"],
      autoResolveObjective: true,
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.equal(result.outcomes[0].status, "error");
  assert.match(
    result.outcomes[0].error,
    /RUNNER_RESULT_DOES_NOT_MATCH_PRECOMMITTED_DELIVERY/,
  );
  assert.equal(
    mcp.calls.some(
      (call) =>
        call.name === "agentpool_v43_deliver_milestone_onchain",
    ),
    false,
  );
});
