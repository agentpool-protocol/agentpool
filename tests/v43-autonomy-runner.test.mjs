import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  performanceProfileKey,
  rankWorkChoicesByExpectedNetProfit,
  selectWinningBids,
  validateExecutionResult,
  verifiedSuccessBps,
} from "../runner/agentpool-autonomy-core.mjs";
import {
  buildExecutorResultSchema,
  computeWorkspaceDigest,
  createExecutionAdapter,
  createExecutorRegistry,
  materializeCandidateArtifact,
  resolveProviderLaunch,
} from "../runner/execution-adapters.mjs";
import {
  generatePrivateChannelKeyPair,
  openPrivateJson,
  sealPrivateJson,
} from "../runner/private-channel.mjs";
import {
  readVerifiedPerformanceForBids,
  runAutonomyRoleCycle,
  runCandidateRewardSettlementCycle,
  runIdleImprovementCycle,
  runValidatorCycle,
  validateIdleImprovementAudit,
  validateImprovementCandidateExecution,
} from "../runner/agentpool-role-runner-core.mjs";
import { newRunnerState } from "../runner/agentpool-runner-core.mjs";

const address = (value) => `0x${String(value).padStart(40, "0")}`;

test("executor schema satisfies strict nested required-property rules", () => {
  const schema = buildExecutorResultSchema();
  const assertStrictObject = (node) => {
    if (!node || typeof node !== "object") return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object")) {
      assert.deepEqual(
        [...node.required].sort(),
        Object.keys(node.properties).sort(),
      );
      assert.equal(node.additionalProperties, false);
      for (const property of Object.values(node.properties)) {
        assertStrictObject(property);
      }
    }
    if (node.items) assertStrictObject(node.items);
  };
  assertStrictObject(schema);
});

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

test("self-reported performance cannot manipulate autonomous awards", () => {
  const plan = buildTaskDag({
    schema: "agentpool.autonomy.opportunity/v1",
    id: "opportunity:self-report",
    capability: "code",
    maxBudgetApool: "10",
    task: { kind: "AGENT_EXECUTE" },
  });
  const task = plan.tasks[0];
  const cheap = createRiskAdjustedBid(task, {
    provider: "new-cheap",
    bidderAddress: address(10),
    operatorGroup: "group-cheap",
    runtimeHash: "runtime-cheap",
    priceApool: "1",
    successLowerBps: 1,
    capacityUnits: 1,
    expiresAt: Date.now() + 60_000,
  });
  const expensive = createRiskAdjustedBid(task, {
    provider: "self-promoted",
    bidderAddress: address(11),
    operatorGroup: "group-expensive",
    runtimeHash: "runtime-expensive",
    priceApool: "2",
    successLowerBps: 10_000,
    capacityUnits: 1,
    expiresAt: Date.now() + 60_000,
  });
  expensive.riskAdjustedBaseUnits = "0";

  assert.equal(cheap.selfEstimatedSuccessBps, 1);
  assert.equal(expensive.selfEstimatedSuccessBps, 10_000);
  assert.equal(cheap.successLowerBps, 5_000);
  assert.equal(expensive.successLowerBps, 5_000);
  assert.equal(
    selectWinningBids(plan, [expensive, cheap]).selected[0].provider,
    "new-cheap",
  );
});

test("only verified outcomes improve autonomous award ranking", () => {
  const plan = buildTaskDag({
    schema: "agentpool.autonomy.opportunity/v1",
    id: "opportunity:verified-history",
    capability: "code",
    maxBudgetApool: "10",
    task: { kind: "AGENT_EXECUTE" },
  });
  const task = plan.tasks[0];
  const cold = createRiskAdjustedBid(task, {
    provider: "cold",
    bidderAddress: address(12),
    operatorGroup: "group-cold",
    runtimeHash: "runtime-cold",
    priceApool: "1",
    successLowerBps: 10_000,
    capacityUnits: 1,
    expiresAt: Date.now() + 60_000,
  });
  const proven = createRiskAdjustedBid(task, {
    provider: "proven",
    bidderAddress: address(13),
    operatorGroup: "group-proven",
    runtimeHash: "runtime-proven",
    priceApool: "2",
    successLowerBps: 1,
    capacityUnits: 1,
    expiresAt: Date.now() + 60_000,
  });
  const provenKey = performanceProfileKey(proven);
  const award = selectWinningBids(
    plan,
    [cold, proven],
    {
      verifiedPerformance: {
        [provenKey]: { attempts: 20, successes: 20 },
      },
    },
  );

  assert.equal(verifiedSuccessBps(), 5_000);
  assert.equal(verifiedSuccessBps({ attempts: 20, successes: 20 }), 9_166);
  assert.equal(award.selected[0].provider, "proven");
  assert.equal(award.selected[0].performanceSource, "VERIFIED_OUTCOMES");
  assert.throws(
    () => verifiedSuccessBps({ attempts: 1, successes: 2 }),
    /AUTONOMY_PERFORMANCE_RECORD_INVALID/,
  );
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

test("candidate evidence comes from actual workspace changes and host tests", async () => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentpool-candidate-evidence-root-"),
  );
  const workspace = path.join(testRoot, "source");
  const artifactRoot = path.join(testRoot, "artifacts");
  const replayRoot = path.join(testRoot, "replays");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "candidate.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { existsSync } from "node:fs";',
        'import test from "node:test";',
        'test("candidate", () => assert.equal(existsSync("candidate.txt"), true));',
      ].join("\n"),
    );
    const output = JSON.stringify({
      content: "Implemented and tested an isolated candidate change.",
      evidence: {
        summary: "self-reported summary",
        digest: "self-reported-digest",
        changedFiles: ["fabricated.txt"],
        testCommand: "fabricated-command",
        testPassed: false,
        patchDigest: "fabricated-digest",
      },
      usage: { mode: "test", units: 1 },
    });
    const adapter = createExecutionAdapter({
      provider: "codex",
      enabled: true,
      command: process.execPath,
      args: [
        "-e",
        [
          'require("node:fs").writeFileSync("candidate.txt", "real change");',
          `process.stdout.write(${JSON.stringify(output)});`,
        ].join(""),
      ],
      workspace,
      allowedWorkspaceRoots: [testRoot],
      verifyCandidateWorkspace: true,
      allowWorkspaceWrite: true,
      candidateArtifactRoot: artifactRoot,
    });
    const result = await adapter.execute({
      instruction: "implement candidate",
      workspaceMode: "ISOLATED_CANARY",
    });
    assert.deepEqual(result.evidence.changedFiles, ["candidate.txt"]);
    assert.equal(result.evidence.testPassed, true);
    assert.equal(result.evidence.hostVerified, true);
    assert.match(result.evidence.patchDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(
      result.evidence.sourceSnapshotDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(
      result.evidence.artifactDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(result.evidence.artifactSizeBytes > 0, true);
    assert.equal(result.evidence.objectiveCanaryPassed, true);
    assert.equal(result.evidence.candidateMetrics.qualityBps, 10_000);
    assert.equal(result.evidence.baselineMetrics.qualityBps, 0);
    assert.equal(
      existsSync(result.evidence.localArtifactPath),
      true,
    );
    assert.equal(
      existsSync(path.join(workspace, "candidate.txt")),
      false,
    );
    assert.equal(result.evidence.testCommand, "node --test tests/*.test.mjs");
    const replay = await materializeCandidateArtifact({
      baseWorkspace: workspace,
      artifactPath: result.evidence.localArtifactPath,
      artifactDigest: result.evidence.artifactDigest,
      targetRoot: replayRoot,
    });
    assert.deepEqual(replay.changedFiles, ["candidate.txt"]);
    assert.equal(
      await readFile(
        path.join(replay.workspace, "candidate.txt"),
        "utf8",
      ),
      "real change",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
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
  assert.deepEqual(
    decideWorkPowerVote(null, {
      eligiblePower: 10_000n,
      minimumParticipants: 5,
      minimumGroups: 3,
    }),
    {
      approved: false,
      participants: 0,
      groups: 0,
      participation: "0",
      support: "0",
      quorumReached: false,
      supportReached: false,
    },
  );
});

test("a bootstrap runner may self-canary but cannot turn it into a vote", async () => {
  const candidate = {
    id: "evt:self-candidate",
    eventType: "IMPROVEMENT_CANDIDATE",
    opportunityId: "improvement:self-canary",
    actorAddress: address(9),
    body: {
      payload: {
        issueId: "issue:self-canary",
        evidence: {
          candidateMetrics: {
            qualityBps: 10_000,
            cost: 10,
            latencyMs: 10,
            securityRegressions: 0,
          },
          baselineMetrics: {
            qualityBps: 0,
            cost: 10,
            latencyMs: 10,
            securityRegressions: 1,
          },
        },
        expiresAt: Date.now() + 60_000,
      },
    },
    createdAt: 10,
    expiresAt: Date.now() + 60_000,
  };
  const mcp = relayMcp([candidate]);
  const state = newRunnerState();
  const canary = await runAutonomyRoleCycle({
    config: { roles: ["CANARY", "VOTER"] },
    mcp,
    state,
    wallet: { address: address(9) },
    now: 20,
  });
  assert.equal(canary.outcomes[0].status, "advisory-only");
  const event = mcp.events.find(
    (entry) => entry.eventType === "CANARY_RESULT",
  );
  assert.equal(event.body.payload.independent, false);
  assert.equal(event.body.payload.advisoryOnly, true);
  assert.equal(event.body.payload.createsWorkPower, false);

  const vote = await runAutonomyRoleCycle({
    config: { roles: ["CANARY", "VOTER"] },
    mcp,
    state,
    wallet: { address: address(9) },
    now: Date.now() + 1,
  });
  assert.equal(
    vote.outcomes.some(
      (outcome) =>
        outcome.role === "VOTER" &&
        outcome.reason === "INDEPENDENT_CANARY_REQUIRED",
    ),
    true,
  );
  assert.equal(
    mcp.events.some((entry) => entry.eventType === "WORK_POWER_VOTE"),
    false,
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
  const artifacts = new Map();
  const relay = {
    events,
    calls,
    artifacts,
    publisherAddress: address(9),
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
          actorAddress: relay.publisherAddress,
          body,
          createdAt: Date.now() + events.length,
          expiresAt: args.expiresAt,
        };
        events.push(event);
        return { id: event.id };
      }
      if (
        name === "agentpool_v43_publish_candidate_artifact"
      ) {
        const manifest = JSON.parse(args.artifactJson);
        artifacts.set(args.artifactDigest, args.artifactJson);
        return {
          artifactDigest: args.artifactDigest,
          authorAddress: relay.publisherAddress,
          sourceSnapshotDigest: manifest.sourceSnapshotDigest,
          patchDigest: manifest.patchDigest,
          sizeBytes: Buffer.byteLength(args.artifactJson),
          immutable: true,
          publicPath:
            `/api/v4.3/candidates/artifacts?digest=${encodeURIComponent(args.artifactDigest)}`,
        };
      }
      if (name === "agentpool_v43_candidate_artifact") {
        const artifactJson = artifacts.get(args.artifactDigest);
        if (!artifactJson) {
          throw new Error("V43_CANDIDATE_ARTIFACT_NOT_FOUND");
        }
        const manifest = JSON.parse(artifactJson);
        return {
          artifactDigest: args.artifactDigest,
          artifactJson,
          sizeBytes: Buffer.byteLength(artifactJson),
          sourceSnapshotDigest: manifest.sourceSnapshotDigest,
          patchDigest: manifest.patchDigest,
        };
      }
      if (name === "agentpool_v43_resolve_milestone_onchain") {
        return { transactionHash: `0x${"42".repeat(32)}` };
      }
      if (name === "agentpool_v43_verified_performance") {
        return {
          rankEligible: false,
          source: "COLD_START",
          reason: "LEGACY_LEDGER_NO_RUNTIME_CAPABILITY_HISTORY",
          attempts: "0",
          successes: "0",
        };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  return relay;
}

test("autonomous candidate reward cycle quotes before work and completes one-AI incubation", async () => {
  const wallet = { address: address(9) };
  const issueId = "issue:autonomous-reward-e2e";
  const opportunityId = "improvement:autonomous-reward-e2e";
  const sourceSnapshotDigest = `sha256:${"ab".repeat(32)}`;
  const artifactDigest = `sha256:${"cd".repeat(32)}`;
  const patchDigest = `sha256:${"ef".repeat(32)}`;
  const issueEvent = {
    id: "evt:reward-issue",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId,
    actorAddress: wallet.address,
    body: {
      payload: {
        issueId,
        evidence: { digest: "reproduced-defect-v1" },
        sourceSnapshotDigest,
        acceptanceCriteria: { regressionTestRequired: true },
      },
    },
    createdAt: 1,
    expiresAt: 60_000,
  };
  const events = [issueEvent];
  const calls = [];
  const issue = {
    state: "NONE",
    deadlines: { bid: 2, delivery: 10, commit: 20, reveal: 30 },
    candidates: [],
    validations: [],
    selectedCandidateId: 0,
    artifactDigest: null,
  };
  let paidApool = 0;
  const mcp = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "agentpool_v439_candidate_reward_status") {
        return { deployed: true };
      }
      if (name === "agentpool_v43_shared_coordination") {
        return {
          events: events.filter(
            (event) =>
              (!args.eventType ||
                event.eventType === args.eventType) &&
              (!args.opportunityId ||
                event.opportunityId === args.opportunityId),
          ),
        };
      }
      if (name === "agentpool_v439_candidate_reward_issue") {
        return structuredClone(issue);
      }
      if (name === "agentpool_v439_open_candidate_reward_issue") {
        issue.state = "BIDDING";
        return { transactionHash: `0x${"01".repeat(32)}` };
      }
      if (name === "agentpool_v439_prepare_candidate_bid") {
        return { planCommitment: `0x${"11".repeat(32)}` };
      }
      if (name === "agentpool_v439_submit_candidate_bid") {
        issue.candidates.push({
          candidateId: 1,
          author: wallet.address,
          quoteApool: args.quoteApool,
        });
        issue.selectedCandidateId = 1;
        return { transactionHash: `0x${"02".repeat(32)}` };
      }
      if (name === "agentpool_v439_award_candidate") {
        issue.state = "RUNNING";
        return { transactionHash: `0x${"03".repeat(32)}` };
      }
      if (name === "agentpool_v439_deliver_candidate") {
        issue.state = "VALIDATING";
        issue.artifactDigest = args.artifactDigest;
        return { transactionHash: `0x${"04".repeat(32)}` };
      }
      if (name === "agentpool_v439_prepare_validation") {
        return {
          validationCommitment: `0x${"22".repeat(32)}`,
        };
      }
      if (name === "agentpool_v439_commit_validation") {
        issue.validations.push({
          validator: wallet.address,
          commitment: args.validationCommitment,
          quoteApool: args.quoteApool,
          revealed: false,
        });
        return { transactionHash: `0x${"05".repeat(32)}` };
      }
      if (name === "agentpool_v439_reveal_validation") {
        issue.validations[0].revealed = true;
        return { transactionHash: `0x${"06".repeat(32)}` };
      }
      if (name === "agentpool_v439_finalize_candidate_reward") {
        issue.state = "SETTLED";
        paidApool = 0.1 + 1 + 0.2;
        return { transactionHash: `0x${"07".repeat(32)}` };
      }
      throw new Error(`UNEXPECTED_TOOL:${name}`);
    },
  };
  const state = newRunnerState();
  const config = {
    candidateReward: {
      enabled: true,
      reporterQuoteApool: "0.1",
      candidateQuoteApool: "1",
      validatorQuoteApool: "0.2",
      budgetCapApool: "3",
      bidMinutes: 1,
      deliveryMinutes: 2,
      commitMinutes: 3,
      revealMinutes: 4,
    },
  };
  const runAt = (now) =>
    runCandidateRewardSettlementCycle({
      config,
      mcp,
      state,
      wallet,
      now,
    });

  assert.equal((await runAt(1_000)).outcomes[0].status, "issue-opened");
  assert.equal(
    (await runAt(1_100)).outcomes[0].status,
    "candidate-bid-submitted",
  );
  assert.equal(
    (await runAt(3_000)).outcomes[0].status,
    "candidate-awarded",
  );
  assert.equal(
    (await runAt(3_100)).outcomes[0].status,
    "awaiting-selected-candidate-delivery",
  );

  events.push({
    id: "evt:reward-candidate",
    eventType: "IMPROVEMENT_CANDIDATE",
    opportunityId,
    actorAddress: wallet.address,
    body: {
      payload: {
        issueId,
        evidence: { artifactDigest, patchDigest },
      },
    },
    createdAt: 4,
    expiresAt: 60_000,
  });
  assert.equal(
    (await runAt(3_200)).outcomes[0].status,
    "candidate-delivered",
  );
  events.push({
    id: "evt:reward-canary",
    eventType: "CANARY_RESULT",
    opportunityId,
    actorAddress: wallet.address,
    body: {
      payload: {
        artifactDigest,
        assessment: { passed: true },
        candidate: { qualityBps: 10_000 },
        baseline: { qualityBps: 0 },
        replayedArtifact: true,
      },
    },
    createdAt: 5,
    expiresAt: 60_000,
  });
  assert.equal(
    (await runAt(4_000)).outcomes[0].status,
    "validation-committed",
  );
  assert.equal(
    (await runAt(21_000)).outcomes[0].status,
    "validation-revealed",
  );
  assert.equal(
    (await runAt(31_000)).outcomes[0].status,
    "finalized",
  );
  assert.equal(
    (await runAt(32_000)).outcomes[0].status,
    "settled",
  );
  assert.equal(paidApool, 1.3);
  const openIndex = calls.findIndex(
    (call) =>
      call.name ===
      "agentpool_v439_open_candidate_reward_issue",
  );
  const bidIndex = calls.findIndex(
    (call) =>
      call.name === "agentpool_v439_submit_candidate_bid",
  );
  const deliveryIndex = calls.findIndex(
    (call) =>
      call.name === "agentpool_v439_deliver_candidate",
  );
  assert.ok(openIndex >= 0 && bidIndex > openIndex);
  assert.ok(deliveryIndex > bidIndex);
});

test("reward-enabled improver cannot edit a candidate before its bid is awarded", async () => {
  const issueId = "issue:prework-gate";
  const event = {
    id: "evt:prework-gate",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId: "improvement:prework-gate",
    actorAddress: address(9),
    body: {
      payload: {
        issueId,
        provider: "codex",
        sourceSnapshotDigest: `sha256:${"12".repeat(32)}`,
        expiresAt: 60_000,
      },
    },
    createdAt: 1,
    expiresAt: 60_000,
  };
  let executions = 0;
  const result = await runAutonomyRoleCycle({
    config: {
      roles: ["IMPROVER"],
      candidateReward: { enabled: true },
    },
    mcp: relayMcp([event]),
    state: newRunnerState(),
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        executions += 1;
        throw new Error("PREWORK_EXECUTION_MUST_NOT_HAPPEN");
      },
    },
    now: 10,
  });
  assert.equal(
    result.outcomes[0].status,
    "awaiting-prework-reward-award",
  );
  assert.equal(executions, 0);
  assert.equal(
    result.state.autonomy.candidateRewards[issueId].stage,
    "DISCOVERED",
  );
});

test("coordinator imports only rank-eligible onchain capability history", async () => {
  const bids = [
    {
      bidderAddress: address(1),
      runtimeHash: "runtime-a",
      capability: "code",
    },
    {
      bidderAddress: address(2),
      runtimeHash: "runtime-b",
      capability: "code",
    },
  ];
  const calls = [];
  const performance = await readVerifiedPerformanceForBids(
    {
      async call(name, args) {
        calls.push({ name, args });
        return args.agent === address(1)
          ? {
              rankEligible: true,
              attempts: "8",
              successes: "7",
            }
          : {
              rankEligible: false,
              attempts: "999",
              successes: "999",
            };
      },
    },
    bids,
  );
  assert.deepEqual(performance, {
    [performanceProfileKey(bids[0])]: {
      attempts: 8,
      successes: 7,
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) => call.name === "agentpool_v43_verified_performance",
    ),
  );
});

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
          testCommand:
            "node --test tests/v43-autonomy-runner.test.mjs",
          testPassed: true,
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
    "UNFUNDED_ADVISORY_UNTIL_CANDIDATE_VERIFIED",
  );
  assert.equal(issue.body.payload.rewardCapApool, "0");
  assert.equal(issue.body.payload.candidateRewardCapApool, "2");

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
      sourceSnapshotDigest: `sha256:${"12".repeat(32)}`,
      artifactDigest: `sha256:${"34".repeat(32)}`,
      artifactSizeBytes: 1_024,
      objectiveCanaryPassed: true,
      objectiveCanaryReason:
        "REGRESSION_TEST_FAILS_ON_BASELINE_AND_PASSES_ON_CANDIDATE",
      candidateMetrics: {
        qualityBps: 10_000,
        cost: 10,
        latencyMs: 10,
        securityRegressions: 0,
      },
      baselineMetrics: {
        qualityBps: 0,
        cost: 10,
        latencyMs: 10,
        securityRegressions: 1,
      },
      hostVerified: true,
    },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.evidence.changedFiles.length, 2);
});

test("idle improvement retries an unfulfilled issue with host-verified evidence", async () => {
  const opportunityId = "improvement:retry-candidate";
  const issueEvent = {
    id: "evt:retry-candidate-issue",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId,
    actorAddress: address(9),
    body: {
      payload: {
        issueId: "issue:retry-candidate",
        provider: "codex",
        instruction: "Implement the isolated retry candidate.",
        acceptanceCriteria: { focusedTestRequired: true },
        expiresAt: 10_000,
      },
    },
    createdAt: 10,
    expiresAt: 10_000,
  };
  const mcp = relayMcp([issueEvent]);
  const state = newRunnerState();
  state.autonomy = {
    cursor: 11,
    processed: {
      "evt:retry-candidate-issue:WATCHER,IMPROVER": 20,
    },
    validations: {},
    idleImprovement: {
      lastAttemptAt: 10,
      lastAuditAt: 10,
      lastCandidateAttemptAt: 20,
      activeOpportunityId: opportunityId,
      activeIssueEventId: issueEvent.id,
      activeCandidateEventId: null,
    },
  };
  const result = await runIdleImprovementCycle({
    config: {
      roles: ["WATCHER", "IMPROVER"],
      idleImprovement: {
        enabled: true,
        candidateRetryIntervalMs: 1,
      },
    },
    mcp,
    state,
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        return {
          provider: "codex",
          content:
            "Implemented the isolated retry candidate and verified it.",
          evidence: {
            summary: "host verified retry",
            digest: "retry-candidate-v1",
            changedFiles: ["runner/retry-candidate.mjs"],
            testCommand: "node --test tests/*.test.mjs",
            testPassed: true,
            patchDigest: `sha256:${"ab".repeat(32)}`,
            sourceSnapshotDigest: `sha256:${"cd".repeat(32)}`,
            artifactDigest: `sha256:${"ef".repeat(32)}`,
            artifactSizeBytes: 2_048,
            artifactJson: JSON.stringify({
              schema: "agentpool.candidate.patch/v1",
              sourceSnapshotDigest: `sha256:${"cd".repeat(32)}`,
              patchDigest: `sha256:${"ab".repeat(32)}`,
              testCommand: "node --test tests/*.test.mjs",
              testPassed: true,
              objectiveCanary: { passed: true },
              changes: [
                {
                  path: "runner/retry-candidate.mjs",
                  action: "ADD",
                  beforeSha256: null,
                  afterSha256: "ab".repeat(32),
                  contentBase64: "Y2FuZGlkYXRl",
                },
              ],
            }),
            objectiveCanaryPassed: true,
            objectiveCanaryReason:
              "REGRESSION_TEST_FAILS_ON_BASELINE_AND_PASSES_ON_CANDIDATE",
            candidateMetrics: {
              qualityBps: 10_000,
              cost: 10,
              latencyMs: 10,
              securityRegressions: 0,
            },
            baselineMetrics: {
              qualityBps: 0,
              cost: 10,
              latencyMs: 10,
              securityRegressions: 1,
            },
            hostVerified: true,
          },
        };
      },
    },
    now: 100,
  });
  assert.equal(result.outcomes[0].status, "candidate-published");
  assert.equal(
    mcp.events.filter(
      (event) => event.eventType === "IMPROVEMENT_CANDIDATE",
    ).length,
    1,
  );
  assert.equal(state.autonomy.idleImprovement.activeOpportunityId, null);
});

test("a candidate is published, independently replayed, canaried, and voted without mutating the source", async () => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentpool-autonomous-improvement-e2e-"),
  );
  const source = path.join(testRoot, "source");
  const artifacts = path.join(testRoot, "artifacts");
  const candidates = path.join(testRoot, "candidates");
  const replays = path.join(testRoot, "replays");
  try {
    await mkdir(path.join(source, "tests"), { recursive: true });
    await writeFile(
      path.join(source, "feature.mjs"),
      "export const fixed = false;\n",
    );
    await writeFile(
      path.join(source, "tests", "feature.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { fixed } from "../feature.mjs";',
        'test("the isolated candidate fixes the defect", () => {',
        "  assert.equal(fixed, true);",
        "});",
      ].join("\n"),
    );
    const sourceSnapshotDigest =
      await computeWorkspaceDigest(source);
    const executorOutput = JSON.stringify({
      content:
        "Implemented the reproducible defect fix in the isolated candidate workspace.",
      evidence: {
        summary: "isolated objective fix",
        digest: "isolated-objective-fix-v1",
      },
    });
    const adapter = createExecutionAdapter({
      provider: "codex",
      enabled: true,
      command: process.execPath,
      args: [
        "-e",
        [
          'require("node:fs").writeFileSync("feature.mjs", "export const fixed = true;\\n");',
          `process.stdout.write(${JSON.stringify(executorOutput)});`,
        ].join(""),
      ],
      workspace: source,
      allowedWorkspaceRoots: [testRoot],
      verifyCandidateWorkspace: true,
      allowWorkspaceWrite: true,
      candidateWorkspaceRoot: candidates,
      candidateArtifactRoot: artifacts,
      sourceSnapshotDigest,
      timeoutMs: 10_000,
    });
    const issue = {
      id: "evt:objective-e2e-issue",
      eventType: "IMPROVEMENT_ISSUE",
      opportunityId: "improvement:objective-e2e",
      actorAddress: address(8),
      body: {
        payload: {
          issueId: "issue:objective-e2e",
          provider: "codex",
          instruction:
            "Fix the reproducible false feature flag in an isolated candidate.",
          acceptanceCriteria: {
            test: "tests/feature.test.mjs",
          },
          sourceSnapshotDigest,
          expiresAt: Date.now() + 60_000,
        },
      },
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const mcp = relayMcp([issue]);
    mcp.publisherAddress = address(9);
    const improvement = await runAutonomyRoleCycle({
      config: {
        roles: ["IMPROVER"],
        improvementProvider: "codex",
        requirePinnedImprovementIssues: true,
        sourceSnapshotDigest,
        operatorGroup: "candidate-operator-group",
        runtime: "candidate-runtime",
        independenceClaim: true,
      },
      mcp,
      state: newRunnerState(),
      wallet: { address: address(9) },
      executorRegistry: {
        execute: (task) => adapter.execute(task),
      },
      now: 10,
    });
    assert.equal(improvement.outcomes[0].status, "candidate-published");
    assert.equal(
      await readFile(path.join(source, "feature.mjs"), "utf8"),
      "export const fixed = false;\n",
    );
    const candidate = mcp.events.find(
      (event) => event.eventType === "IMPROVEMENT_CANDIDATE",
    );
    assert.ok(candidate);
    assert.equal(candidate.body.payload.evidence.hostVerified, true);
    assert.equal(
      candidate.body.payload.evidence.objectiveCanaryPassed,
      true,
    );
    assert.equal(
      mcp.artifacts.has(
        candidate.body.payload.evidence.artifactDigest,
      ),
      true,
    );

    mcp.publisherAddress = address(7);
    const canary = await runAutonomyRoleCycle({
      config: {
        roles: ["CANARY"],
        operatorGroup: "validator-operator-group",
        independenceClaim: true,
        candidateVerification: {
          baseWorkspace: source,
          targetRoot: replays,
          executorConfig: { timeoutMs: 10_000 },
        },
      },
      mcp,
      state: newRunnerState(),
      wallet: { address: address(7) },
      now: 20,
    });
    assert.equal(
      canary.outcomes.some(
        (outcome) =>
          outcome.role === "CANARY" &&
          outcome.status === "proven",
      ),
      true,
    );
    const canaryEvent = mcp.events.find(
      (event) =>
        event.eventType === "CANARY_RESULT" &&
        event.actorAddress === address(7),
    );
    assert.equal(canaryEvent.body.payload.independent, true);
    assert.equal(canaryEvent.body.payload.replayedArtifact, true);
    assert.equal(canaryEvent.body.payload.rewardEligible, true);
    assert.equal(canaryEvent.body.payload.createsWorkPower, false);

    mcp.publisherAddress = address(6);
    const vote = await runAutonomyRoleCycle({
      config: {
        roles: ["VOTER"],
        operatorGroup: "independent-voter-group",
      },
      mcp,
      state: newRunnerState(),
      wallet: { address: address(6) },
      now: 30,
    });
    assert.equal(
      vote.outcomes.some(
        (outcome) =>
          outcome.role === "VOTER" &&
          outcome.status === "support",
      ),
      true,
    );
    assert.equal(
      mcp.events.some(
        (event) =>
          event.eventType === "WORK_POWER_VOTE" &&
          event.actorAddress === address(6),
      ),
      true,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("idle improvement stops retrying after the bounded candidate limit", async () => {
  const opportunityId = "improvement:bounded-retry";
  const issueEvent = {
    id: "evt:bounded-retry-issue",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId,
    actorAddress: address(9),
    body: {
      payload: {
        issueId: "issue:bounded-retry",
        provider: "codex",
        instruction: "Implement safely.",
        expiresAt: 10_000,
      },
    },
    createdAt: 10,
    expiresAt: 10_000,
  };
  const state = newRunnerState();
  state.autonomy = {
    cursor: 11,
    processed: {},
    validations: {},
    idleImprovement: {
      activeOpportunityId: opportunityId,
      activeIssueEventId: issueEvent.id,
      activeCandidateEventId: null,
      candidateAttemptCount: 3,
    },
  };
  const result = await runIdleImprovementCycle({
    config: {
      roles: ["WATCHER", "IMPROVER"],
      idleImprovement: {
        enabled: true,
        maximumCandidateAttempts: 3,
      },
    },
    mcp: relayMcp([issueEvent]),
    state,
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        throw new Error("SHOULD_NOT_RETRY");
      },
    },
    now: 100,
  });
  assert.equal(result.outcomes[0].status, "candidate-abandoned");
  assert.equal(state.autonomy.idleImprovement.activeOpportunityId, null);
});

test("transient autonomy execution errors do not advance the relay cursor", async () => {
  const issueEvent = {
    id: "evt:transient-executor-error",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId: "improvement:transient-error",
    actorAddress: address(8),
    body: {
      payload: {
        issueId: "issue:transient-error",
        provider: "codex",
        instruction: "Implement safely.",
        acceptanceCriteria: {},
        expiresAt: 10_000,
      },
    },
    createdAt: 50,
    expiresAt: 10_000,
  };
  const state = newRunnerState();
  const result = await runAutonomyRoleCycle({
    config: { roles: ["IMPROVER"], improvementProvider: "codex" },
    mcp: relayMcp([issueEvent]),
    state,
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        throw new Error("TRANSIENT_EXECUTOR_FAILURE");
      },
    },
    now: 100,
  });
  assert.equal(result.outcomes[0].status, "error");
  assert.equal(state.autonomy.cursor, 0);
  assert.equal(
    state.autonomy.processed[
      "evt:transient-executor-error:IMPROVER"
    ],
    undefined,
  );
});

test("pinned improvement issues cannot execute against another source snapshot", async () => {
  const issueEvent = {
    id: "evt:pinned-source-mismatch",
    eventType: "IMPROVEMENT_ISSUE",
    opportunityId: "improvement:pinned-source-mismatch",
    actorAddress: address(8),
    body: {
      payload: {
        issueId: "issue:pinned-source-mismatch",
        provider: "codex",
        instruction: "Implement safely.",
        sourceSnapshotDigest: `sha256:${"11".repeat(32)}`,
        expiresAt: 10_000,
      },
    },
    createdAt: 50,
    expiresAt: 10_000,
  };
  let executions = 0;
  const state = newRunnerState();
  const result = await runAutonomyRoleCycle({
    config: {
      roles: ["IMPROVER"],
      improvementProvider: "codex",
      requirePinnedImprovementIssues: true,
      sourceSnapshotDigest: `sha256:${"22".repeat(32)}`,
    },
    mcp: relayMcp([issueEvent]),
    state,
    wallet: { address: address(9) },
    executorRegistry: {
      async execute() {
        executions += 1;
      },
    },
    now: 100,
  });
  assert.equal(result.outcomes[0].status, "candidate-superseded");
  assert.equal(
    result.outcomes[0].reason,
    "ISSUE_SOURCE_SNAPSHOT_SUPERSEDED",
  );
  assert.equal(executions, 0);
  assert.equal(state.autonomy.cursor, 51);
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
