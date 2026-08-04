import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, toBytes } from "viem";
import {
  RUNNER_TASK_SCHEMA,
  canonicalJson,
  executeBuiltinTask,
  newRunnerState,
  processJobTerms,
  runRunnerCycle,
  shouldAcceptTerms,
} from "../runner/agentpool-runner-core.mjs";
import {
  generatePrivateChannelKeyPair,
  openPrivateJson,
} from "../runner/private-channel.mjs";
import { sealRunnerResultForBuyer } from "../runner/agentpool-role-runner-core.mjs";

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

function fakeMcp(events = [event()], walletOverrides = {}) {
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
          registered: true,
          ...walletOverrides,
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

test("a fresh device identity is registered before polling paid work", async () => {
  const mcp = fakeMcp([], { registered: false });
  const result = await runRunnerCycle({
    config: {
      operatorGroup: "external-device-group",
      runtime: "external-runner-v1",
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.deepEqual(
    mcp.calls.map((call) => call.name),
    [
      "agentpool_v43_wallet_status",
      "agentpool_v43_register_onchain",
      "agentpool_v43_shared_coordination",
    ],
  );
  assert.equal(
    mcp.calls[1].args.operatorGroup,
    "external-device-group",
  );
  assert.equal(result.wallet.registered, true);
  assert.ok(result.onboarding.registration.transactionHash);
});

test("a zero-context runner creates a disposable testnet wallet before onboarding", async () => {
  const calls = [];
  let configured = false;
  const mcp = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v43_wallet_status") {
        return configured
          ? {
              configured: true,
              address: worker,
              testnetOnly: true,
              registered: true,
              baseSepoliaEth: "0",
            }
          : {
              configured: false,
              testnetOnly: true,
            };
      }
      if (name === "agentpool_v43_create_test_wallet") {
        configured = true;
        return {
          created: true,
          address: worker,
          walletPath: "C:/device-local/wallet.json",
          faucetGuide: "https://docs.base.org/faucets",
        };
      }
      if (name === "agentpool_v43_shared_coordination") {
        return { events: [] };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  const result = await runRunnerCycle({
    config: {
      autoCreateTestnetWallet: true,
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "agentpool_v43_wallet_status",
      "agentpool_v43_create_test_wallet",
      "agentpool_v43_wallet_status",
      "agentpool_v43_shared_coordination",
    ],
  );
  assert.deepEqual(calls[1].args, { confirmTestnetOnly: true });
  assert.equal(
    result.onboarding.walletCreated.walletPath,
    "C:/device-local/wallet.json",
  );
  assert.equal(result.wallet.address, worker);
});

test("a new zero-gas wallet requests test gas before onchain registration", async () => {
  const calls = [];
  let configured = false;
  const mcp = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v43_wallet_status") {
        return configured
          ? {
              configured: true,
              address: worker,
              testnetOnly: true,
              registered: false,
              baseSepoliaEth: "0",
            }
          : { configured: false, testnetOnly: true };
      }
      if (name === "agentpool_v43_create_test_wallet") {
        configured = true;
        return {
          created: true,
          address: worker,
          walletPath: "C:/device-local/wallet.json",
        };
      }
      if (name === "agentpool_v43_publish_coordination") {
        return { id: "evt:gas-request" };
      }
      if (name === "agentpool_v43_request_test_gas") {
        return {
          ok: false,
          state: "PENDING_SPONSOR",
          requestEventId: args.requestEventId,
        };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  const result = await runRunnerCycle({
    config: {
      autoCreateTestnetWallet: true,
      minimumGasEth: "0.000001",
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "agentpool_v43_wallet_status",
      "agentpool_v43_create_test_wallet",
      "agentpool_v43_wallet_status",
      "agentpool_v43_publish_coordination",
      "agentpool_v43_request_test_gas",
    ],
  );
  assert.equal(result.outcomes[0].status, "gas-hold");
  assert.equal(result.outcomes[0].gasGrant.state, "PENDING_SPONSOR");
  assert.equal(
    result.onboarding.walletCreated.address,
    worker,
  );
  assert.equal(
    calls.some(
      (call) => call.name === "agentpool_v43_register_onchain",
    ),
    false,
  );
});

test("a confirmed automatic grant resumes registration in the same cycle", async () => {
  const calls = [];
  let walletReads = 0;
  const mcp = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v43_wallet_status") {
        walletReads += 1;
        return {
          configured: true,
          address: worker,
          testnetOnly: true,
          registered: false,
          baseSepoliaEth: walletReads === 1 ? "0" : "0.000003",
        };
      }
      if (name === "agentpool_v43_publish_coordination") {
        return { id: "evt:gas-request" };
      }
      if (name === "agentpool_v43_request_test_gas") {
        return {
          ok: true,
          grant: {
            status: "CONFIRMED",
            transactionHash: `0x${"12".repeat(32)}`,
          },
        };
      }
      if (name === "agentpool_v43_register_onchain") {
        return {
          registered: true,
          transactionHash: `0x${"34".repeat(32)}`,
        };
      }
      if (name === "agentpool_v43_shared_coordination") {
        return { events: [] };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  const result = await runRunnerCycle({
    config: {
      operatorGroup: "external-device-group",
      runtime: "external-runner-v1",
      minimumGasEth: "0.000001",
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "agentpool_v43_wallet_status",
      "agentpool_v43_publish_coordination",
      "agentpool_v43_request_test_gas",
      "agentpool_v43_wallet_status",
      "agentpool_v43_register_onchain",
      "agentpool_v43_shared_coordination",
    ],
  );
  assert.equal(result.wallet.registered, true);
  assert.equal(result.wallet.baseSepoliaEth, "0.000003");
  assert.equal(result.state.gasRequest, null);
  assert.equal(result.state.gasGrant, null);
});

test("a sponsor outage keeps a zero-gas runner safely held and retryable", async () => {
  const mcp = {
    async call(name) {
      if (name === "agentpool_v43_wallet_status") {
        return {
          configured: true,
          address: worker,
          testnetOnly: true,
          registered: false,
          baseSepoliaEth: "0",
        };
      }
      if (name === "agentpool_v43_publish_coordination") {
        return { id: "evt:gas-request" };
      }
      if (name === "agentpool_v43_request_test_gas") {
        throw new Error("V43_GAS_SPONSOR_STATUS_FAILED:503");
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  const result = await runRunnerCycle({
    config: { minimumGasEth: "0.000001" },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.equal(result.outcomes[0].status, "gas-hold");
  assert.equal(result.outcomes[0].gasGrant.state, "PENDING_SPONSOR");
  assert.equal(result.outcomes[0].gasGrant.recoverable, true);
  assert.match(
    result.outcomes[0].gasGrant.reason,
    /V43_GAS_SPONSOR_STATUS_FAILED/,
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

test("a transient settlement error is retried without duplicate delivery", async () => {
  const mcp = fakeMcp();
  const originalCall = mcp.call.bind(mcp);
  let rejectResolveOnce = true;
  mcp.call = async (name, args) => {
    if (
      name === "agentpool_v43_resolve_milestone_onchain" &&
      rejectResolveOnce
    ) {
      rejectResolveOnce = false;
      mcp.calls.push({ name, args });
      throw new Error("TRANSIENT_CHAIN_ERROR");
    }
    return originalCall(name, args);
  };
  const first = await runRunnerCycle({
    config: {
      capabilities: ["mcp-json-data-code-low-risk"],
      autoResolveObjective: true,
    },
    mcp,
    state: newRunnerState(),
    fetchChainSnapshot: async () => ({ activity: [] }),
  });
  assert.equal(first.outcomes[0].status, "error");
  assert.equal(first.state.cursor, event().createdAt);

  const second = await runRunnerCycle({
    config: {
      capabilities: ["mcp-json-data-code-low-risk"],
      autoResolveObjective: true,
    },
    mcp,
    state: first.state,
    fetchChainSnapshot: async () => ({
      activity: [
        {
          event: "MilestoneDelivered",
          args: { jobId: terms().jobId, milestone: 0 },
        },
      ],
    }),
  });
  assert.equal(second.outcomes[0].status, "settled");
  assert.equal(
    mcp.calls.filter(
      (call) =>
        call.name === "agentpool_v43_deliver_milestone_onchain",
    ).length,
    1,
  );
  assert.equal(
    mcp.calls.filter(
      (call) =>
        call.name === "agentpool_v43_resolve_milestone_onchain",
    ).length,
    2,
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

test("private results publish only an HPKE envelope while the chain receives the committed hash", async () => {
  const buyerKeys = await generatePrivateChannelKeyPair();
  const privateTerms = terms({
    expectedDelivery: undefined,
    expectedDeliveryHash: keccak256(toBytes('{"a":1,"b":2}')),
    resultRecipientPublicKey: buyerKeys.publicKey,
  });
  const mcp = fakeMcp([event(privateTerms)]);
  const result = await processJobTerms({
    event: event(privateTerms),
    walletAddress: worker,
    config: { autoResolveObjective: false },
    mcp,
    chainSnapshot: { activity: [] },
    state: newRunnerState(),
    sealResult: sealRunnerResultForBuyer,
  });
  assert.equal(result.status, "delivered");
  const published = mcp.calls.find(
    (call) =>
      call.name === "agentpool_v43_publish_coordination",
  );
  const payload = JSON.parse(published.args.payloadJson);
  assert.equal(Object.hasOwn(payload, "result"), false);
  assert.equal(payload.resultVisibility, "HPKE_RECIPIENT_ONLY");
  assert.deepEqual(
    await openPrivateJson(
      buyerKeys.privateKey,
      payload.privateResultEnvelope,
    ),
    {
      schema: "agentpool.private-result/v1",
      jobId: privateTerms.jobId,
      result: '{"a":1,"b":2}',
    },
  );
});
