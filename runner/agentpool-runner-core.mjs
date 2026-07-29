import {
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
} from "viem";

export const RUNNER_TASK_SCHEMA = "agentpool.runner.task/v1";
export const RUNNER_EVENT_TYPES = Object.freeze({
  terms: "JOB_TERMS",
  result: "RESULT_AVAILABLE",
  settlement: "SETTLEMENT_RECEIPT",
  heartbeat: "RUNNER_HEARTBEAT",
  improvementCandidate: "IMPROVEMENT_CANDIDATE",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseRunnerTask(value) {
  const task = typeof value === "string" ? JSON.parse(value) : value;
  if (!isPlainObject(task) || task.schema !== RUNNER_TASK_SCHEMA) {
    throw new Error("RUNNER_UNSUPPORTED_TASK_SCHEMA");
  }
  if (typeof task.kind !== "string") {
    throw new Error("RUNNER_TASK_KIND_REQUIRED");
  }
  return task;
}

export function executeBuiltinTask(value) {
  const task = parseRunnerTask(value);
  switch (task.kind) {
    case "JSON_CANONICALIZE":
      return canonicalJson(task.input);
    case "JSON_PICK": {
      if (!isPlainObject(task.input) || !Array.isArray(task.fields)) {
        throw new Error("RUNNER_JSON_PICK_INVALID_INPUT");
      }
      const picked = {};
      for (const field of task.fields) {
        if (typeof field !== "string") {
          throw new Error("RUNNER_JSON_PICK_INVALID_FIELD");
        }
        if (Object.hasOwn(task.input, field)) picked[field] = task.input[field];
      }
      return canonicalJson(picked);
    }
    case "JSON_MERGE": {
      if (
        !Array.isArray(task.inputs) ||
        task.inputs.some((item) => !isPlainObject(item))
      ) {
        throw new Error("RUNNER_JSON_MERGE_INVALID_INPUT");
      }
      return canonicalJson(Object.assign({}, ...task.inputs));
    }
    case "JSON_SUM": {
      if (
        !Array.isArray(task.values) ||
        task.values.some(
          (item) => typeof item !== "number" || !Number.isFinite(item),
        )
      ) {
        throw new Error("RUNNER_JSON_SUM_INVALID_INPUT");
      }
      return canonicalJson({
        sum: task.values.reduce((total, item) => total + item, 0),
      });
    }
    default:
      throw new Error(`RUNNER_TASK_ADAPTER_REQUIRED:${task.kind}`);
  }
}

export function expectedNetProfitBaseUnits(terms, config) {
  const workerAmount = parseUnits(String(terms.workerAmountApool), 18);
  const estimatedCost = parseUnits(
    String(config.estimatedCostApool ?? "0"),
    18,
  );
  const estimatedGas = parseUnits(
    String(config.estimatedGasApool ?? "0"),
    18,
  );
  return workerAmount - estimatedCost - estimatedGas;
}

export function shouldAcceptTerms(terms, walletAddress, config) {
  if (Number(terms.chainId) !== 84532) {
    return { accept: false, reason: "BASE_SEPOLIA_ONLY" };
  }
  if (
    String(terms.workerAddress).toLowerCase() !==
    String(walletAddress).toLowerCase()
  ) {
    return { accept: false, reason: "NOT_ASSIGNED_WORKER" };
  }
  if (
    Array.isArray(config.capabilities) &&
    config.capabilities.length > 0 &&
    !config.capabilities.includes(terms.capability)
  ) {
    return { accept: false, reason: "CAPABILITY_NOT_ALLOWED" };
  }
  let task;
  try {
    task = parseRunnerTask(terms.task);
  } catch (error) {
    return {
      accept: false,
      reason: error instanceof Error ? error.message : "INVALID_TASK",
    };
  }
  const minimum = parseUnits(String(config.minNetProfitApool ?? "0"), 18);
  const net = expectedNetProfitBaseUnits(terms, config);
  if (net < minimum) {
    return { accept: false, reason: "BELOW_MIN_NET_PROFIT", net };
  }
  return { accept: true, reason: "ELIGIBLE", net, task };
}

export function unwrapCoordinationEvent(event) {
  const envelope = event?.body;
  const payload = envelope?.payload;
  if (!isPlainObject(payload)) {
    throw new Error("RUNNER_COORDINATION_PAYLOAD_INVALID");
  }
  return payload;
}

export function parseMcpToolResult(result, toolName) {
  const content = result?.content?.[0];
  const message =
    content?.type === "text" ? content.text : JSON.stringify(result?.content);
  if (result?.isError) throw new Error(`${toolName}:${message}`);
  if (content?.type !== "text") {
    throw new Error(`${toolName}:RUNNER_MCP_TEXT_RESULT_REQUIRED`);
  }
  return JSON.parse(content.text);
}

export function stagePresent(activity, jobId, eventName, milestone = 0) {
  return activity.some((entry) => {
    if (entry.event !== eventName) return false;
    const args = entry.args ?? {};
    return (
      String(args.jobId).toLowerCase() === String(jobId).toLowerCase() &&
      (args.milestone === undefined ||
        Number(args.milestone) === Number(milestone))
    );
  });
}

export function newRunnerState() {
  return {
    schema: "agentpool.runner.state/v1",
    cursor: 0,
    jobs: {},
    lastHeartbeatAt: 0,
  };
}

export async function processJobTerms({
  event,
  walletAddress,
  config,
  mcp,
  chainSnapshot,
  state,
  executeTask = executeBuiltinTask,
  sealResult,
  now = Date.now(),
}) {
  const terms = unwrapCoordinationEvent(event);
  const jobId = String(terms.jobId);
  const milestone = Number(terms.milestone ?? 0);
  const prior = state.jobs[jobId] ?? { stage: "DISCOVERED" };
  if (prior.stage === "SETTLED") {
    return { status: "already-settled", state };
  }

  const decision = shouldAcceptTerms(terms, walletAddress, config);
  if (!decision.accept) {
    state.jobs[jobId] = {
      ...prior,
      stage: "SKIPPED",
      reason: decision.reason,
      updatedAt: now,
    };
    return { status: "skipped", reason: decision.reason, state };
  }

  const result = await executeTask(decision.task, { terms, config });
  if (typeof result !== "string") {
    throw new Error("RUNNER_ADAPTER_MUST_RETURN_STRING");
  }
  if (
    terms.proofMode === "OBJECTIVE_HASH_V1" &&
    (terms.expectedDeliveryHash
      ? keccak256(toBytes(result)).toLowerCase() !==
        String(terms.expectedDeliveryHash).toLowerCase()
      : result !== terms.expectedDelivery)
  ) {
    throw new Error("RUNNER_RESULT_DOES_NOT_MATCH_PRECOMMITTED_DELIVERY");
  }

  const activity = chainSnapshot?.activity ?? [];
  if (
    prior.stage === "DISCOVERED" &&
    !stagePresent(activity, jobId, "MilestoneAccepted", milestone)
  ) {
    const receipt = await mcp.call(
      "agentpool_v43_accept_milestone_onchain",
      { jobId, milestone },
    );
    prior.acceptTransactionHash = receipt.transactionHash;
  }
  prior.stage = "ACCEPTED";
  prior.updatedAt = now;
  state.jobs[jobId] = prior;

  if (!stagePresent(activity, jobId, "MilestoneDelivered", milestone)) {
    const receipt = await mcp.call(
      "agentpool_v43_deliver_milestone_onchain",
      { jobId, milestone, delivery: result },
    );
    prior.deliverTransactionHash = receipt.transactionHash;
  }
  prior.stage = "DELIVERED";
  prior.result = result;
  prior.updatedAt = now;

  const expiresAt = Math.min(
    Number(terms.deadline) * 1_000,
    now + 30 * 24 * 60 * 60 * 1_000,
  );
  if (!prior.resultEventId) {
    const privateResultEnvelope =
      terms.resultRecipientPublicKey && sealResult
        ? await sealResult(
            result,
            terms.resultRecipientPublicKey,
            jobId,
          )
        : null;
    const published = await mcp.call("agentpool_v43_publish_coordination", {
      eventType: RUNNER_EVENT_TYPES.result,
      opportunityId: event.opportunityId,
      parentEventId: event.id,
      payloadJson: JSON.stringify({
        schema: "agentpool.runner.result/v1",
        chainId: 84532,
        jobId,
        milestone,
        buyerAddress: terms.buyerAddress,
        workerAddress: walletAddress,
        ...(privateResultEnvelope
          ? {
              privateResultEnvelope,
              resultVisibility: "HPKE_RECIPIENT_ONLY",
            }
          : { result }),
        expectedDelivery: terms.expectedDelivery,
        deliverTransactionHash: prior.deliverTransactionHash ?? null,
      }),
      expiresAt,
    });
    prior.resultEventId = published.id;
  }

  if (
    config.autoResolveObjective === true &&
    terms.proofMode === "OBJECTIVE_HASH_V1" &&
    !stagePresent(activity, jobId, "MilestoneSettled", milestone)
  ) {
    const receipt = await mcp.call(
      "agentpool_v43_resolve_milestone_onchain",
      {
        jobId,
        milestone,
        proofText: terms.proofText,
        recipients: terms.recipients,
        amountsApool: terms.amountsApool,
      },
    );
    prior.settlementTransactionHash = receipt.transactionHash;
    prior.stage = "SETTLED";
    if (!prior.settlementEventId) {
      const published = await mcp.call(
        "agentpool_v43_publish_coordination",
        {
          eventType: RUNNER_EVENT_TYPES.settlement,
          opportunityId: event.opportunityId,
          parentEventId: prior.resultEventId,
          payloadJson: JSON.stringify({
            schema: "agentpool.runner.settlement/v1",
            chainId: 84532,
            jobId,
            milestone,
            buyerAddress: terms.buyerAddress,
            workerAddress: walletAddress,
            settlementTransactionHash: receipt.transactionHash,
            emissionApool: "0",
          }),
          expiresAt,
        },
      );
      prior.settlementEventId = published.id;
    }
  }
  prior.updatedAt = now;
  state.jobs[jobId] = prior;
  return {
    status: prior.stage.toLowerCase(),
    jobId,
    result,
    state,
  };
}

export async function runRunnerCycle({
  config,
  mcp,
  state,
  fetchChainSnapshot,
  executeTask,
  sealResult,
  now = Date.now(),
}) {
  let wallet = await mcp.call("agentpool_v43_wallet_status", {});
  let walletCreated = null;
  if (
    !wallet.configured &&
    config.autoCreateTestnetWallet === true
  ) {
    walletCreated = await mcp.call(
      "agentpool_v43_create_test_wallet",
      { confirmTestnetOnly: true },
    );
    wallet = await mcp.call("agentpool_v43_wallet_status", {});
  }
  if (!wallet.configured || !wallet.testnetOnly) {
    throw new Error("RUNNER_BASE_SEPOLIA_WALLET_REQUIRED");
  }
  let registration = null;
  const onboardingState = () =>
    walletCreated || registration
      ? {
          walletCreated: walletCreated
            ? {
                created: walletCreated.created === true,
                address: walletCreated.address,
                walletPath: walletCreated.walletPath,
                faucetGuide: walletCreated.faucetGuide,
              }
            : null,
          registration,
        }
      : null;
  if (
    config.minimumGasEth &&
    wallet.baseSepoliaEth !== undefined &&
    parseEther(String(wallet.baseSepoliaEth)) <
      parseEther(String(config.minimumGasEth))
  ) {
    const expiresAt = now + 60 * 60 * 1_000;
    if (
      !state.gasRequest ||
      Number(state.gasRequest.expiresAt) <= now
    ) {
      const requested = await mcp.call(
        "agentpool_v43_publish_coordination",
        {
          eventType: "GAS_REQUEST",
          opportunityId: `gas:${String(wallet.address).toLowerCase()}`,
          payloadJson: JSON.stringify({
            schema: "agentpool.gas-request/v1",
            chainId: 84532,
            recipientAddress: wallet.address,
            currentBalanceEth: String(wallet.baseSepoliaEth),
            minimumBalanceEth: String(config.minimumGasEth),
            testnetOnly: true,
            expiresAt,
          }),
          expiresAt,
        },
      );
      state.gasRequest = {
        eventId: requested.id,
        expiresAt,
      };
    }
    let gasGrant = state.gasGrant ?? null;
    const grantRetryMs = Number(config.gasGrantRetryMs ?? 5 * 60 * 1_000);
    if (
      !state.lastGasGrantAttemptAt ||
      now - Number(state.lastGasGrantAttemptAt) >= grantRetryMs
    ) {
      try {
        gasGrant = await mcp.call(
          "agentpool_v43_request_test_gas",
          { requestEventId: state.gasRequest.eventId },
        );
      } catch (error) {
        gasGrant = {
          ok: false,
          state: "PENDING_SPONSOR",
          recoverable: true,
          reason:
            error instanceof Error
              ? error.message.slice(0, 240)
              : "TESTNET_GAS_SPONSOR_UNAVAILABLE",
        };
      }
      state.gasGrant = gasGrant;
      state.lastGasGrantAttemptAt = now;
      if (
        gasGrant?.state === "NOT_NEEDED" ||
        gasGrant?.grant?.status === "CONFIRMED"
      ) {
        wallet = await mcp.call("agentpool_v43_wallet_status", {});
        if (
          parseEther(String(wallet.baseSepoliaEth)) >=
          parseEther(String(config.minimumGasEth))
        ) {
          state.gasRequest = null;
          state.gasGrant = null;
        }
      }
    }
    if (
      parseEther(String(wallet.baseSepoliaEth)) >=
      parseEther(String(config.minimumGasEth))
    ) {
      state.gasRequest = null;
      state.gasGrant = null;
    } else {
      return {
        wallet,
        onboarding: onboardingState(),
        outcomes: [
          {
            status: "gas-hold",
            reason: "BASE_SEPOLIA_GAS_BELOW_MINIMUM",
            gasGrant,
          },
        ],
        state,
      };
    }
  }
  if (wallet.registered === false) {
    const addressSuffix = String(wallet.address).slice(-12).toLowerCase();
    registration = await mcp.call("agentpool_v43_register_onchain", {
      operatorGroup:
        config.operatorGroup ?? `runner-device-${addressSuffix}`,
      runtime: config.runtime ?? "agentpool-runner-v1",
    });
    wallet.registered = true;
    wallet.operatorGroup =
      config.operatorGroup ?? `runner-device-${addressSuffix}`;
    wallet.runtime = config.runtime ?? "agentpool-runner-v1";
  }
  const onboarding = onboardingState();
  const relay = await mcp.call("agentpool_v43_shared_coordination", {
    eventType: RUNNER_EVENT_TYPES.terms,
    since: state.cursor,
    limit: 200,
  });
  const events = relay.events ?? [];
  const chainSnapshot = await fetchChainSnapshot();
  const outcomes = [];
  let retryFrom = null;
  for (const event of events) {
    const payload = unwrapCoordinationEvent(event);
    if (
      String(payload.workerAddress).toLowerCase() ===
      String(wallet.address).toLowerCase()
    ) {
      try {
        outcomes.push(
          await processJobTerms({
            event,
            walletAddress: wallet.address,
            config,
            mcp,
            chainSnapshot,
            state,
            executeTask,
            sealResult,
            now,
          }),
        );
      } catch (error) {
        const jobId = String(payload.jobId);
        state.jobs[jobId] = {
          ...(state.jobs[jobId] ?? {}),
          stage: "ERROR",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: now,
        };
        outcomes.push({
          status: "error",
          jobId,
          error: state.jobs[jobId].error,
        });
        retryFrom =
          retryFrom === null
            ? Number(event.createdAt)
            : Math.min(retryFrom, Number(event.createdAt));
      }
    }
    state.cursor = Math.max(state.cursor, Number(event.createdAt) + 1);
  }
  if (retryFrom !== null) {
    state.cursor = Math.min(state.cursor, retryFrom);
  }
  const heartbeatInterval = Number(
    config.heartbeatIntervalMs ?? 0,
  );
  if (
    heartbeatInterval > 0 &&
    now - Number(state.lastHeartbeatAt ?? 0) >= heartbeatInterval
  ) {
    const jobs = Object.values(state.jobs);
    const errors = jobs.filter((job) => job.stage === "ERROR").length;
    const active = jobs.filter((job) =>
      ["ACCEPTED", "DELIVERED"].includes(job.stage),
    ).length;
    await mcp.call("agentpool_v43_publish_coordination", {
      eventType: RUNNER_EVENT_TYPES.heartbeat,
      opportunityId: `runner:${String(wallet.address).toLowerCase()}`,
      payloadJson: JSON.stringify({
        schema: "agentpool.runner.heartbeat/v1",
        chainId: 84532,
        address: wallet.address,
        testnetOnly: true,
        runtime: config.runtime ?? "agentpool-runner-v1",
        operatorGroup: config.operatorGroup ?? null,
        roles: config.roles ?? ["WORKER"],
        capabilities: config.capabilities ?? [],
        privateChannelPublicKey:
          config.privateChannelPublicKey ?? null,
        metrics: {
          jobsObserved: jobs.length,
          activeJobs: active,
          stuckJobs: 0,
          errorRateBps:
            jobs.length === 0
              ? 0
              : Math.floor((errors * 10_000) / jobs.length),
          p95LatencyMs: 0,
          securityRegressions: 0,
        },
        expiresAt: now + 2 * heartbeatInterval,
      }),
      expiresAt: now + 2 * heartbeatInterval,
    });
    state.lastHeartbeatAt = now;
  }
  return { wallet, onboarding, outcomes, state };
}
