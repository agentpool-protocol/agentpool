import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTaskDag,
  createRiskAdjustedBid,
  decideWorkPowerVote,
  detectImprovementIssues,
  evaluateCanary,
  gasDecision,
  rankWorkChoicesByExpectedNetProfit,
  selectWinningBids,
  validateExecutionResult,
} from "../runner/agentpool-autonomy-core.mjs";
import {
  createExecutionAdapter,
  createExecutorRegistry,
  resolveProviderLaunch,
} from "../runner/execution-adapters.mjs";
import {
  generatePrivateChannelKeyPair,
  openPrivateJson,
  sealPrivateJson,
} from "../runner/private-channel.mjs";
import {
  runAutonomyRoleCycle,
  runIdleImprovementCycle,
  runValidatorCycle,
  validateIdleImprovementAudit,
  validateImprovementCandidateExecution,
} from "../runner/agentpool-role-runner-core.mjs";
import { newRunnerState } from "../runner/agentpool-runner-core.mjs";

const address = (value) => `0x${String(value).padStart(40, "0")}`;

function opportunity() {
  return {
    schema: "agentpool.autonomy.opportunity/v1",
    id: "opportunity:three-ai",
    capability: "planning",
    maxBudgetApool: "30",
    expiresAt: Date.now() + 60_000,
    task: {
      steps: [
        {
          id: "research",
          capability: "research",
          dependencies: [],
          task: { kind: "AGENT_EXECUTE", provider: "qwen" },
          weight: 1,
        },
        {
          id: "build",
          capability: "code",
          dependencies: ["research"],
          task: { kind: "AGENT_EXECUTE", provider: "codex" },
          weight: 2,
        },
        {
          id: "review",
          capability: "review",
          dependencies: ["build"],
          task: { kind: "AGENT_EXECUTE", provider: "claude" },
          weight: 1,
        },
      ],
    },
  };
}

test("three provider capabilities form one budget-safe DAG", () => {
  const plan = buildTaskDag(opportunity());
  assert.deepEqual(
    plan.tasks.map((task) => task.dependencies),
    [[], ["research"], ["build"]],
  );
  const profiles = [
    ["research", "qwen", address(1)],
    ["code", "codex", address(2)],
    ["review", "claude", address(3)],
  ];
  const bids = plan.tasks.map((task, index) =>
    createRiskAdjustedBid(task, {
      capability: profiles[index][0],
      provider: profiles[index][1],
      bidderAddress: profiles[index][2],
      operatorGroup: `group-${index}`,
      priceApool: index === 1 ? "10" : "5",
      successLowerBps: 9_000,
      capacityUnits: 1,
      expiresAt: Date.now() + 60_000,
    }),
  );
  const award = selectWinningBids(plan, bids);
  assert.deepEqual(
    award.selected.map((bid) => bid.provider),
    ["qwen", "codex", "claude"],
  );
  assert.equal(award.reservedBaseUnits, "20000000000000000000");
});

test("market type never overrides expected net profit", () => {
  const systemWins = rankWorkChoicesByExpectedNetProfit(
    [
      {
        id: "cheap-external",
        market: "EXTERNAL",
        rewardApool: "0.2",
        successProbabilityBps: 10_000,
        estimatedCostApool: "0.1",
      },
      {
        id: "valuable-system-improvement",
        market: "SYSTEM_IMPROVEMENT",
        rewardApool: "2",
        successProbabilityBps: 8_000,
        estimatedCostApool: "0.2",
        failureLossApool: "0.1",
      },
    ],
    { minimumNetProfitApool: "0.01", capacityUnits: 1 },
  );
  assert.equal(systemWins[0].id, "valuable-system-improvement");

  const externalWins = rankWorkChoicesByExpectedNetProfit(
    [
      {
        id: "valuable-external",
        market: "EXTERNAL",
        rewardApool: "5",
        successProbabilityBps: 9_000,
        estimatedCostApool: "0.5",
      },
      {
        id: "small-system-improvement",
        market: "SYSTEM_IMPROVEMENT",
        rewardApool: "1",
        successProbabilityBps: 9_000,
        estimatedCostApool: "0.2",
      },
    ],
    { minimumNetProfitApool: "0.01", capacityUnits: 1 },
  );
  assert.equal(externalWins[0].id, "valuable-external");
});

test("process adapters use shell=false and normalize all provider outputs", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "agentpool-adapter-test-"),
  );
  try {
    for (const provider of ["codex", "claude", "qwen"]) {
      const output = JSON.stringify({
        content: `${provider}-result`,
        evidence: { provider },
        usage: { units: 1 },
      });
      const adapter = createExecutionAdapter({
        provider,
        enabled: true,
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        workspace,
        allowedWorkspaceRoots: [workspace],
      });
      assert.deepEqual(await adapter.execute({ instruction: "safe" }), {
        schema: "agentpool.executor.result/v1",
        provider,
        content: `${provider}-result`,
        evidence: { provider },
        usage: { units: 1 },
      });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex covers unavailable optional providers without changing the requested task", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "agentpool-codex-first-test-"),
  );
  try {
    const output = JSON.stringify({
      content: "codex-result",
      evidence: { deterministic: true },
      usage: { units: 1 },
    });
    const registry = createExecutorRegistry({
      allowProviderFallback: true,
      preferredProviders: ["codex", "claude", "qwen"],
      codex: {
        enabled: true,
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        workspace,
        allowedWorkspaceRoots: [workspace],
      },
      claude: { enabled: false },
      qwen: { enabled: false },
    });
    const result = await registry.execute({
      provider: "claude",
      instruction: "safe",
    });
    assert.equal(result.provider, "codex");
    assert.deepEqual(result.evidence.routing, {
      requestedProvider: "claude",
      actualProvider: "codex",
      fallback: true,
    });
    assert.equal(
      registry.providers().find((entry) => entry.provider === "codex")
        .available,
      true,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project-local Codex avoids the inaccessible Windows Store alias", () => {
  const launch = resolveProviderLaunch("codex", {});
  assert.equal(launch.command, process.execPath);
  assert.match(
    launch.prefixArgs[0],
    /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/,
  );
  assert.equal(launch.source, "project-local-codex");
});

test("private task and result envelopes round-trip and detect tampering", async () => {
  const keys = await generatePrivateChannelKeyPair();
  const envelope = await sealPrivateJson(keys.publicKey, {
    secretTask: "not visible to the relay",
  });
  assert.deepEqual(await openPrivateJson(keys.privateKey, envelope), {
    secretTask: "not visible to the relay",
  });
  await assert.rejects(
    openPrivateJson(keys.privateKey, {
      ...envelope,
      ciphertextHash: `0x${"00".repeat(32)}`,
    }),
    /PRIVATE_CHANNEL_CIPHERTEXT_HASH_MISMATCH/,
  );
});

test("validator determines evidence while payout fields stay outside its result", () => {
  const validation = validateExecutionResult({
    result: {
      schema: "agentpool.executor.result/v1",
      content: "verified",
    },
    policy: "EXACT",
    deterministicExpected: "verified",
  });
  assert.deepEqual(validation, {
    passed: true,
    scoreBps: 10_000,
    reason: "EXACT_MATCH",
  });
  assert.equal(Object.hasOwn(validation, "payoutAmount"), false);
});

test("canary adoption and Work Power rules reject single-agent control", () => {
  assert.deepEqual(
    detectImprovementIssues(
      { errorRateBps: 800, stuckJobs: 0 },
      { maximumErrorRateBps: 500 },
    ).map((issue) => issue.issueType),
    ["RUNNER_ERROR_RATE"],
  );
  const canary = evaluateCanary(
    {
      qualityBps: 9_500,
      cost: 80,
      latencyMs: 80,
      securityRegressions: 0,
    },
    { qualityBps: 9_000, cost: 100, latencyMs: 100 },
    {
      minimumQualityGainBps: 100,
      minimumCostSavingBps: 1_000,
      minimumLatencySavingBps: 1_000,
    },
  );
  assert.equal(canary.passed, true);
  assert.equal(
    decideWorkPowerVote(
      [
        {
          agentId: "one",
          operatorGroup: "one",
          power: 10_000n,
          support: true,
        },
      ],
      { eligiblePower: 10_000n },
    ).approved,
    false,
  );
  const votes = Array.from({ length: 6 }, (_, index) => ({
    agentId: `agent-${index}`,
    operatorGroup: `group-${index % 3}`,
    power: 1_000n,
    support: index < 5,
  }));
  assert.equal(
    decideWorkPowerVote(votes, { eligiblePower: 10_000n }).approved,
    true,
  );
});

test("gas policy self-funds, sponsors, or pauses without debt", () => {
  assert.equal(
    gasDecision({
      balanceWei: 20n,
      minimumBalanceWei: 10n,
      estimatedTransactionWei: 5n,
    }).state,
    "SELF_FUNDED",
  );
  assert.equal(
    gasDecision({
      balanceWei: 1n,
      minimumBalanceWei: 10n,
      estimatedTransactionWei: 5n,
      sponsorBudgetWei: 20n,
    }).state,
    "SPONSOR_ELIGIBLE",
  );
  assert.equal(
    gasDecision({
      balanceWei: 1n,
      minimumBalanceWei: 10n,
      estimatedTransactionWei: 5n,
      sponsorBudgetWei: 0n,
    }).state,
    "GAS_HOLD",
  );
});

function relayMcp(initialEvents = []) {
  const events = [...initialEvents];
  const calls = [];
  return {
    events,
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v43_shared_coordination") {
        return {
          events: events.filter(
            (event) =>
              Number(event.createdAt) >= Number(args.since ?? 0) &&
              (!args.eventType || event.eventType === args.eventType) &&
              (!args.opportunityId ||
                event.opportunityId === args.opportunityId),
          ),
        };
      }
      if (name === "agentpool_v43_publish_coordination") {
        const body = { payload: JSON.parse(args.payloadJson) };
        const event = {
          id: `evt:${events.length + 1}`,
          eventType: args.eventType,
          opportunityId: args.opportunityId,
          actorAddress: address(9),
          body,
          createdAt: Date.now() + events.length,
          expiresAt: args.expiresAt,
        };
        events.push(event);
        return { id: event.id };
      }
      if (name === "agentpool_v43_resolve_milestone_onchain") {
        return { transactionHash: `0x${"42".repeat(32)}` };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
}

test("idle capacity audits a real system issue only when it beats market work", async () => {
  const mcp = relayMcp();
  const originalCall = mcp.call.bind(mcp);
  mcp.call = async (name, args) => {
    if (name === "agentpool_v437_self_bootstrap_status") {
      return {
        open: true,
        availableApool: "8.5",
        caps: { maxItemQuoteApool: "2" },
      };
    }
    return originalCall(name, args);
  };
  const executorRegistry = {
    async execute() {
      return {
        provider: "codex",
        content: JSON.stringify({
          status: "ISSUE",
          title: "Runner misses cross-market expected-profit ranking",
          affectedFiles: ["runner/agentpool-role-runner-core.mjs"],
          reproductionSteps: [
            "Offer one cheap EXTERNAL task and one higher-value SYSTEM_IMPROVEMENT task.",
            "Observe that the market label previously selected the cheaper task.",
          ],
          impact:
            "A cheap external task can occupy capacity while more valuable system work waits.",
          proposedFix:
            "Rank every market choice with one expected-net-profit formula before reserving capacity.",
          acceptanceTest:
            "Assert the system task wins when its expected net profit is higher and the external task wins after its reward increases.",
        }),
        evidence: {
          summary: "reproducible ranking gap",
          digest: "ranking-gap-v1",
        },
      };
    },
  };
  const state = newRunnerState();
  const result = await runIdleImprovementCycle({
    config: {
      roles: ["WATCHER", "IMPROVER"],
      improvementProvider: "codex",
      idleImprovement: {
        enabled: true,
        auditIntervalMs: 1,
        retryIntervalMs: 1,
      },
    },
    mcp,
    state,
    wallet: { address: address(9) },
    executorRegistry,
    marketOutcomes: [
      {
        eventId: "cheap-external",
        market: "EXTERNAL",
        expectedNetProfitApool: "0.1",
      },
    ],
    now: 10,
  });
  assert.equal(result.outcomes[0].status, "issue-published");
  const issue = mcp.events.find(
    (event) => event.eventType === "IMPROVEMENT_ISSUE",
  );
  assert.equal(
    issue.body.payload.funding,
    "SELF_BOOTSTRAP_EXISTING_TAPOOL",
  );
  assert.equal(issue.body.payload.rewardCapApool, "2");

  const higherMarket = await runIdleImprovementCycle({
    config: {
      roles: ["WATCHER", "IMPROVER"],
      idleImprovement: {
        enabled: true,
        auditIntervalMs: 1,
        retryIntervalMs: 1,
      },
    },
    mcp: {
      async call(name) {
        if (name === "agentpool_v437_self_bootstrap_status") {
          return {
            open: true,
            availableApool: "8.5",
            caps: { maxItemQuoteApool: "2" },
          };
        }
        return { events: [] };
      },
    },
    state: newRunnerState(),
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        throw new Error("SHOULD_NOT_AUDIT_LOWER_PROFIT_WORK");
      },
    },
    marketOutcomes: [
      {
        eventId: "valuable-external",
        market: "EXTERNAL",
        expectedNetProfitApool: "5",
      },
    ],
    now: 10,
  });
  assert.equal(
    higherMarket.outcomes[0].status,
    "higher-profit-market-work",
  );
});

test("idle improvement rejects unsupported prose before publishing rewards", async () => {
  assert.deepEqual(
    validateIdleImprovementAudit({
      content: "ISSUE: unsupported claim",
      evidence: {
        summary: "superficial evidence",
        digest: "superficial-v1",
      },
    }),
    {
      status: "invalid-audit-evidence",
      reason: "AUDIT_CONTENT_MUST_BE_JSON",
    },
  );

  const mcp = relayMcp();
  const originalCall = mcp.call.bind(mcp);
  mcp.call = async (name, args) => {
    if (name === "agentpool_v437_self_bootstrap_status") {
      return {
        open: true,
        availableApool: "8.5",
        caps: { maxItemQuoteApool: "2" },
      };
    }
    return originalCall(name, args);
  };
  const result = await runIdleImprovementCycle({
    config: {
      roles: ["WATCHER", "IMPROVER"],
      idleImprovement: {
        enabled: true,
        auditIntervalMs: 1,
        retryIntervalMs: 1,
      },
    },
    mcp,
    state: newRunnerState(),
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        return {
          provider: "codex",
          content: "ISSUE: unsupported claim",
          evidence: {
            summary: "superficial evidence",
            digest: "superficial-v1",
          },
        };
      },
    },
    now: 10,
  });
  assert.equal(
    result.outcomes[0].status,
    "invalid-audit-evidence",
  );
  assert.equal(
    mcp.events.some(
      (event) => event.eventType === "IMPROVEMENT_ISSUE",
    ),
    false,
  );
});

test("an improvement candidate needs changed-file and passing-test evidence", async () => {
  assert.deepEqual(
    validateImprovementCandidateExecution({
      content:
        "The isolated workspace was read-only, so no candidate was implemented.",
      evidence: {
        summary: "write blocked",
        digest: "write-blocked-v1",
      },
    }),
    {
      valid: false,
      reason: "CANDIDATE_CHANGE_AND_TEST_EVIDENCE_REQUIRED",
    },
  );
  const valid = validateImprovementCandidateExecution({
    content:
      "Implemented strict idle-audit evidence validation and added its regression test.",
    evidence: {
      summary: "strict evidence gate",
      digest: "strict-evidence-gate-v1",
      changedFiles: [
        "runner/agentpool-role-runner-core.mjs",
        "tests/v43-autonomy-runner.test.mjs",
      ],
      testCommand: "node --test tests/v43-autonomy-runner.test.mjs",
      testPassed: true,
      patchDigest: "sha256:strict-evidence-gate",
    },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.evidence.changedFiles.length, 2);
});

test("planner, bidder and coordinator roles exchange signed market events", async () => {
  const first = {
    id: "evt:opportunity",
    eventType: "AUTONOMY_OPPORTUNITY",
    opportunityId: "opportunity:three-ai",
    actorAddress: address(8),
    body: { payload: opportunity() },
    createdAt: 1,
    expiresAt: opportunity().expiresAt,
  };
  const mcp = relayMcp([first]);
  const state = newRunnerState();
  await runAutonomyRoleCycle({
    config: {
      roles: ["PLANNER"],
      operatorGroup: "planner-group",
    },
    mcp,
    state,
    wallet: { address: address(7) },
  });
  const plan = mcp.events.find((event) => event.eventType === "AUTONOMY_PLAN");
  assert.ok(plan);

  state.autonomy.cursor = plan.createdAt;
  await runAutonomyRoleCycle({
    config: {
      roles: ["BIDDER"],
      operatorGroup: "worker-group",
      bidProfiles: [
        {
          capability: "research",
          provider: "qwen",
          priceApool: "5",
          successLowerBps: 9_000,
          capacityUnits: 3,
        },
        {
          capability: "code",
          provider: "codex",
          priceApool: "10",
          successLowerBps: 9_000,
          capacityUnits: 3,
        },
        {
          capability: "review",
          provider: "claude",
          priceApool: "5",
          successLowerBps: 9_000,
          capacityUnits: 3,
        },
      ],
    },
    mcp,
    state,
    wallet: { address: address(6) },
  });
  assert.equal(
    mcp.events.filter((event) => event.eventType === "AUTONOMY_BID")
      .length,
    3,
  );

  state.autonomy.cursor = 0;
  state.autonomy.processed = {};
  await runAutonomyRoleCycle({
    config: {
      roles: ["COORDINATOR"],
      operatorGroup: "coordinator-group",
    },
    mcp,
    state,
    wallet: { address: address(5) },
  });
  const award = mcp.events.find((event) => event.eventType === "AUTONOMY_AWARD");
  assert.ok(award);
  assert.equal(
    mcp.events.filter((event) => event.eventType === "AUTONOMY_AWARD")
      .length,
    1,
  );
  assert.equal(award.body.payload.selected.length, 3);
  assert.equal(
    award.body.payload.funding,
    "BUYER_SIGNATURE_REQUIRED_BEFORE_ONCHAIN_EXECUTION",
  );
});

test("independent validator settles an exact worker result", async () => {
  const worker = address(1);
  const validator = address(2);
  const jobId = `0x${"ab".repeat(32)}`;
  const terms = {
    id: "evt:terms",
    eventType: "JOB_TERMS",
    opportunityId: "job:validator-test",
    body: {
      payload: {
        schema: "agentpool.runner.terms/v1",
        jobId,
        milestone: 0,
        buyerAddress: address(3),
        workerAddress: worker,
        validatorAddress: validator,
        expectedDelivery: "ok",
        proofText: "proof",
        recipients: [worker, validator],
        amountsApool: ["1", "0.1"],
        deadline: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  const result = {
    id: "evt:result",
    eventType: "RESULT_AVAILABLE",
    opportunityId: terms.opportunityId,
    actorAddress: worker,
    body: { payload: { result: "ok" } },
    createdAt: 2,
    expiresAt: terms.expiresAt,
  };
  const mcp = relayMcp([terms, result]);
  const state = newRunnerState();
  const outcome = await runValidatorCycle({
    config: { roles: ["VALIDATOR"] },
    mcp,
    state,
    wallet: { address: validator },
  });
  assert.equal(outcome.outcomes[0].status, "settled");
  assert.ok(
    mcp.calls.some(
      (call) =>
        call.name === "agentpool_v43_resolve_milestone_onchain",
    ),
  );
});

test("a restarted validator skips results that already have a settlement notice", async () => {
  const worker = address(1);
  const validator = address(2);
  const jobId = `0x${"cd".repeat(32)}`;
  const opportunityId = "job:already-settled";
  const events = [
    {
      id: "evt:old-terms",
      eventType: "JOB_TERMS",
      opportunityId,
      body: {
        payload: {
          jobId,
          milestone: 0,
          workerAddress: worker,
          validatorAddress: validator,
          expectedDelivery: "done",
          proofText: "proof",
          recipients: [worker, validator],
          amountsApool: ["1", "0.1"],
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    },
    {
      id: "evt:old-result",
      eventType: "RESULT_AVAILABLE",
      opportunityId,
      actorAddress: worker,
      body: { payload: { result: "done" } },
      createdAt: 2,
      expiresAt: Date.now() + 60_000,
    },
    {
      id: "evt:old-settlement",
      eventType: "SETTLEMENT_RECEIPT",
      opportunityId,
      actorAddress: validator,
      body: {
        payload: {
          jobId,
          milestone: 0,
          settlementTransactionHash: `0x${"12".repeat(32)}`,
        },
      },
      createdAt: 3,
      expiresAt: Date.now() + 60_000,
    },
  ];
  const mcp = relayMcp(events);
  const state = newRunnerState();
  const outcome = await runValidatorCycle({
    config: { roles: ["VALIDATOR"] },
    mcp,
    state,
    wallet: { address: validator },
  });
  assert.deepEqual(outcome.outcomes, []);
  assert.equal(
    mcp.calls.some(
      (call) =>
        call.name === "agentpool_v43_resolve_milestone_onchain",
    ),
    false,
  );
  assert.equal(
    state.autonomy.validations["evt:old-result"].stage,
    "SETTLED",
  );
});
