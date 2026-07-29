import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPoolV43Engine,
  digest,
} from "../protocol/autonomy/agentpool-v43-engine.mjs";

function capability(track, {
  successLowerBps = 9_000,
  p95LatencyMs = 1_000,
  costFloor = 10,
} = {}) {
  return { track, successLowerBps, p95LatencyMs, costFloor };
}

function buildEngine() {
  const engine = new AgentPoolV43Engine();
  const agents = [
    ["planner", "group-a", [capability("planning", { successLowerBps: 9_600 })]],
    ["light", "group-b", [capability("code", { successLowerBps: 8_500, costFloor: 20 })]],
    ["ultra", "group-c", [capability("code", { successLowerBps: 9_900, costFloor: 100 })]],
    ["validator-a", "group-d", [capability("validation", { successLowerBps: 9_700 })]],
    ["validator-b", "group-e", [capability("validation", { successLowerBps: 9_600 })]],
    ["validator-c", "group-f", [capability("validation", { successLowerBps: 9_500 })]],
    ["pricer-a", "group-g", [capability("pricing")]],
    ["pricer-b", "group-h", [capability("pricing")]],
    ["pricer-c", "group-i", [capability("pricing")]],
  ];
  for (const [id, group, capabilities] of agents) {
    engine.registerAgent({
      id,
      address: `0x${id.padEnd(40, "0").slice(0, 40)}`,
      operatorGroup: group,
      runtimeHash: digest({ id }),
      capabilities,
      capacity: 3,
    });
  }
  return engine;
}

function publishAndPlan(engine, {
  id,
  kind = "SYSTEM_IMPROVEMENT",
  maxBudget = 1_000,
  releaseId,
  minScoreBps = 7_000,
  taskBudget = 700,
  minValidators = 3,
}) {
  engine.publishOpportunity({
    id,
    kind,
    creator: "watcher",
    specificationHash: digest({ id, specification: true }),
    maxBudget,
    releaseId,
    minScoreBps,
    deadline: 100,
    externalDeposit: kind === "EXTERNAL" ? maxBudget : 0,
    systemEmissionCap: kind === "SYSTEM_IMPROVEMENT" ? maxBudget : 0,
  });
  for (const [agentId, amount] of [
    ["pricer-a", 900],
    ["pricer-b", 920],
    ["pricer-c", 940],
  ]) {
    engine.submitRewardQuote(id, {
      agentId,
      amount,
      riskBps: 500,
      feeAsk: 10,
      evidenceHash: digest({ id, agentId, amount }),
    });
  }
  const tasks = [
    {
      id: "implementation",
      dependencies: [],
      capability: "code",
      maxBudget: taskBudget,
      minValidators,
      minScoreBps,
      deadline: 90,
    },
  ];
  engine.submitPlan(id, {
    id: `${id}-plan`,
    plannerId: "planner",
    tasks,
    plannerFee: 100,
    pricingBudget: 30,
    contingency: maxBudget - taskBudget - 130,
    totalBid: maxBudget,
    bond: 100,
    planHash: digest({
      tasks,
      plannerFee: 100,
      pricingBudget: 30,
      contingency: maxBudget - taskBudget - 130,
    }),
  });
  engine.awardPlan(id);
}

function bidAndSettle(engine, id, {
  worker = "light",
  workerPrice = 250,
  validatorPrice = 50,
  score = 9_000,
} = {}) {
  engine.submitRoleBid(id, "implementation", {
    agentId: worker,
    role: "WORKER",
    price: workerPrice,
    durationMs: worker === "light" ? 500 : 800,
    bond: 100,
    nonce: `${id}-${worker}`,
  });
  for (const agentId of ["validator-a", "validator-b", "validator-c"]) {
    engine.submitRoleBid(id, "implementation", {
      agentId,
      role: "VALIDATOR",
      price: validatorPrice,
      durationMs: 300,
      bond: 50,
      nonce: `${id}-${agentId}`,
    });
  }
  assert.equal(engine.allocateReadyTasks(id), 1);
  engine.deliverTask(id, "implementation", {
    agentId: worker,
    artifactHash: digest({ id, artifact: true }),
    evidenceHash: digest({ id, execution: true }),
  });
  for (const agentId of ["validator-a", "validator-b", "validator-c"]) {
    engine.evaluateTask(id, "implementation", {
      agentId,
      scoreBps: score,
      evidenceHash: digest({ id, agentId, score }),
      objectivePassed: true,
    });
  }
  assert.deepEqual(engine.settleTask(id, "implementation"), {
    passed: true,
    score,
  });
  return engine.finalizeOpportunity(id);
}

function attestCanary(engine, opportunityId, moduleHash, manifestHash, canary) {
  for (const agentId of ["validator-a", "validator-b", "validator-c"]) {
    engine.attestCanary(opportunityId, {
      agentId,
      moduleHash,
      manifestHash,
      evidenceHash: digest({ opportunityId, agentId, canary }),
      metrics: canary,
    });
  }
}

test("autonomous market separates price discovery, evaluation and exact settlement", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "system-1" });

  engine.submitRoleBid("system-1", "implementation", {
    agentId: "ultra",
    role: "WORKER",
    price: 500,
    durationMs: 800,
    bond: 100,
    nonce: "ultra-bid",
  });
  const result = bidAndSettle(engine, "system-1");

  assert.equal(
    engine.opportunity("system-1").tasks[0].allocation.worker.agentId,
    "light",
    "low-risk task should select cheaper risk-adjusted worker",
  );
  assert.equal(result.payouts.light, 250);
  assert.equal(result.payouts.planner, 100);
  assert.equal(result.payouts["validator-a"], 50);
  assert.equal(result.payouts["pricer-a"], 10);
  assert.equal(result.total, 530);
  assert.equal(result.minted, 530);
  assert.equal(engine.assertConservation("system-1"), true);
  assert.equal(engine.agent("light").profiles.code.declaredSuccessBps, 8_500);
  assert.equal(engine.agent("light").profiles.code.verifiedSuccessBps, 6_000);
  assert.equal(engine.agent("light").profiles.code.attempts, 1);
  assert.equal(engine.agent("light").profiles.code.successes, 1);
  assert.equal(engine.agent("ultra").profiles.code.declaredSuccessBps, 9_900);
  assert.equal(engine.agent("ultra").profiles.code.verifiedSuccessBps, 5_000);
});

test("external jobs never mint and return all unused escrow", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "external-1", kind: "EXTERNAL" });
  const result = bidAndSettle(engine, "external-1");

  assert.equal(result.minted, 0);
  assert.equal(result.refunded, 470);
  assert.equal(result.total + result.refunded, 1_000);
  assert.equal(engine.assertConservation("external-1"), true);
});

test("evaluator cannot choose a payout amount", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "no-evaluator-payment" });
  engine.submitRoleBid("no-evaluator-payment", "implementation", {
    agentId: "light",
    role: "WORKER",
    price: 250,
    durationMs: 500,
    bond: 100,
    nonce: "worker",
  });
  for (const agentId of ["validator-a", "validator-b", "validator-c"]) {
    engine.submitRoleBid("no-evaluator-payment", "implementation", {
      agentId,
      role: "VALIDATOR",
      price: 50,
      durationMs: 300,
      bond: 50,
      nonce: agentId,
    });
  }
  engine.allocateReadyTasks("no-evaluator-payment");
  engine.deliverTask("no-evaluator-payment", "implementation", {
    agentId: "light",
    artifactHash: digest("artifact"),
    evidenceHash: digest("evidence"),
  });
  assert.throws(
    () =>
      engine.evaluateTask("no-evaluator-payment", "implementation", {
        agentId: "validator-a",
        scoreBps: 9_000,
        evidenceHash: digest("evaluation"),
        objectivePassed: true,
        payoutAmount: 999_999,
      }),
    /EVALUATOR_CANNOT_SET_PAYOUT/,
  );
});

test("performance-weighted evolution cannot be activated by one agent", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "system-evolution" });
  bidAndSettle(engine, "system-evolution");
  const moduleHash = digest("module-v43");
  const manifestHash = digest("manifest-v43");
  const canary = {
    qualityBps: 9_200,
    baselineQualityBps: 9_000,
    cost: 900,
    baselineCost: 1_000,
    latencyMs: 1_000,
    baselineLatencyMs: 1_000,
    securityRegressions: 0,
  };
  attestCanary(engine, "system-evolution", moduleHash, manifestHash, canary);
  const proposalId = engine.proposeEvolution({
    opportunityId: "system-evolution",
    proposerId: "planner",
    parentRelease: "agentpool-v4.2",
    releaseId: "agentpool-v4.3-candidate",
    moduleHash,
    manifestHash,
    financeInvariantHash: engine.financeInvariantHash,
    canary,
  });
  engine.voteEvolution(proposalId, {
    agentId: "light",
    support: true,
    evidenceHash: digest("light-vote"),
  });
  assert.throws(
    () => engine.finalizeEvolutionVote(proposalId),
    /INSUFFICIENT_VOTERS/,
  );
  assert.equal(engine.recommendedRelease, "agentpool-v4.2");
});

test("supermajority plus independent successful adoption recommends a new release", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "system-evolution" });
  bidAndSettle(engine, "system-evolution");
  const moduleHash = digest("module-v43");
  const manifestHash = digest("manifest-v43");
  const canary = {
    qualityBps: 9_200,
    baselineQualityBps: 9_000,
    cost: 900,
    baselineCost: 1_000,
    latencyMs: 1_000,
    baselineLatencyMs: 1_000,
    securityRegressions: 0,
  };
  attestCanary(engine, "system-evolution", moduleHash, manifestHash, canary);
  const proposalId = engine.proposeEvolution({
    opportunityId: "system-evolution",
    proposerId: "planner",
    parentRelease: "agentpool-v4.2",
    releaseId: "agentpool-v4.3-candidate",
    moduleHash,
    manifestHash,
    financeInvariantHash: engine.financeInvariantHash,
    canary,
  });
  for (const agentId of [
    "light",
    "validator-a",
    "validator-b",
    "validator-c",
    "planner",
  ]) {
    engine.voteEvolution(proposalId, {
      agentId,
      support: true,
      evidenceHash: digest({ proposalId, agentId }),
    });
  }
  engine.finalizeEvolutionVote(proposalId);
  assert.equal(engine.release("agentpool-v4.3-candidate").state, "PROVEN");
  assert.equal(engine.recommendedRelease, "agentpool-v4.2");

  for (let index = 0; index < 5; index++) {
    const id = `candidate-adoption-${index}`;
    publishAndPlan(engine, {
      id,
      kind: "EXTERNAL",
      releaseId: "agentpool-v4.3-candidate",
    });
    bidAndSettle(engine, id);
    const adopter = [
      "light",
      "validator-a",
      "validator-b",
      "validator-c",
      "planner",
    ][index];
    engine.recordAdoption(proposalId, {
      agentId: adopter,
      opportunityId: id,
      outcomeHash: digest({ id, success: true }),
    });
  }
  assert.equal(engine.recommendedRelease, "agentpool-v4.3-candidate");
  assert.equal(engine.release("agentpool-v4.2").state, "PROVEN");
});

test("tasks are surfaced to agents by expected profit", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "profit-routing" });
  const choices = engine.opportunitiesFor("light");
  assert.equal(choices[0].opportunityId, "profit-routing");
  assert.equal(choices[0].taskId, "implementation");
  assert.ok(choices[0].expectedProfit > 0);
});

test("cyclic and over-budget plans are rejected before work starts", () => {
  const engine = buildEngine();
  engine.publishOpportunity({
    id: "invalid-plan",
    kind: "EXTERNAL",
    creator: "buyer",
    specificationHash: digest("invalid-plan"),
    maxBudget: 1_000,
    minScoreBps: 7_000,
    deadline: 100,
    externalDeposit: 1_000,
  });
  const cyclicTasks = [
    {
      id: "a",
      dependencies: ["b"],
      capability: "code",
      maxBudget: 400,
      minValidators: 3,
      minScoreBps: 7_000,
      deadline: 90,
    },
    {
      id: "b",
      dependencies: ["a"],
      capability: "code",
      maxBudget: 400,
      minValidators: 3,
      minScoreBps: 7_000,
      deadline: 90,
    },
  ];
  assert.throws(
    () =>
      engine.submitPlan("invalid-plan", {
        plannerId: "planner",
        tasks: cyclicTasks,
        plannerFee: 100,
        pricingBudget: 30,
        contingency: 70,
        totalBid: 1_000,
        bond: 100,
        planHash: digest({
          tasks: cyclicTasks,
          plannerFee: 100,
          pricingBudget: 30,
          contingency: 70,
        }),
      }),
    /CYCLIC_TASK_GRAPH/,
  );
});

test("a reward-quote sybil group cannot satisfy pricing quorum", () => {
  const engine = buildEngine();
  for (const id of ["pricer-d", "pricer-e"]) {
    engine.registerAgent({
      id,
      address: `local:${id}`,
      operatorGroup: "group-g",
      runtimeHash: digest(id),
      capacity: 1,
      capabilities: [capability("pricing")],
    });
  }
  engine.publishOpportunity({
    id: "quote-sybil",
    kind: "SYSTEM_IMPROVEMENT",
    creator: "watcher",
    specificationHash: digest("quote-sybil"),
    maxBudget: 1_000,
    minScoreBps: 7_000,
    deadline: 100,
    systemEmissionCap: 1_000,
  });
  for (const agentId of ["pricer-a", "pricer-d", "pricer-e"]) {
    engine.submitRewardQuote("quote-sybil", {
      agentId,
      amount: 900,
      riskBps: 500,
      feeAsk: 10,
      evidenceHash: digest(agentId),
    });
  }
  const tasks = [
    {
      id: "implementation",
      dependencies: [],
      capability: "code",
      maxBudget: 700,
      minValidators: 3,
      minScoreBps: 7_000,
      deadline: 90,
    },
  ];
  engine.submitPlan("quote-sybil", {
    plannerId: "planner",
    tasks,
    plannerFee: 100,
    pricingBudget: 30,
    contingency: 170,
    totalBid: 1_000,
    bond: 100,
    planHash: digest({ tasks, plannerFee: 100, pricingBudget: 30, contingency: 170 }),
  });
  assert.throws(
    () => engine.awardPlan("quote-sybil"),
    /INSUFFICIENT_QUOTE_DIVERSITY/,
  );
});

test("budget exhaustion enters hold and permits only bounded replanning", () => {
  const engine = buildEngine();
  publishAndPlan(engine, {
    id: "budget-hold",
    taskBudget: 300,
  });
  engine.submitRoleBid("budget-hold", "implementation", {
    agentId: "light",
    role: "WORKER",
    price: 200,
    durationMs: 500,
    bond: 100,
    nonce: "worker",
  });
  for (const agentId of ["validator-a", "validator-b", "validator-c"]) {
    engine.submitRoleBid("budget-hold", "implementation", {
      agentId,
      role: "VALIDATOR",
      price: 50,
      durationMs: 200,
      bond: 50,
      nonce: agentId,
    });
  }
  assert.equal(engine.allocateReadyTasks("budget-hold"), 0);
  assert.equal(engine.opportunity("budget-hold").state, "REPLAN_REQUIRED");
  const replacementTasks = [
    {
      id: "reduced-scope",
      dependencies: [],
      capability: "code",
      maxBudget: 250,
      minValidators: 1,
      minScoreBps: 7_000,
      deadline: 90,
    },
  ];
  engine.replanOpportunity("budget-hold", {
    plannerId: "planner",
    replacementTasks,
    reasonHash: digest("reduce-scope"),
  });
  assert.equal(engine.opportunity("budget-hold").state, "BIDDING");
});

test("an unrelated address cannot manufacture adoption", () => {
  const engine = buildEngine();
  engine.registerAgent({
    id: "spectator",
    address: "local:spectator",
    operatorGroup: "spectator-group",
    runtimeHash: digest("spectator"),
    capacity: 1,
    capabilities: [capability("validation")],
  });
  publishAndPlan(engine, { id: "system-evolution" });
  bidAndSettle(engine, "system-evolution");
  const moduleHash = digest("module");
  const manifestHash = digest("manifest");
  const canary = {
    qualityBps: 9_100,
    baselineQualityBps: 9_000,
    cost: 900,
    baselineCost: 1_000,
    latencyMs: 1_000,
    baselineLatencyMs: 1_000,
    securityRegressions: 0,
  };
  attestCanary(engine, "system-evolution", moduleHash, manifestHash, canary);
  const proposalId = engine.proposeEvolution({
    opportunityId: "system-evolution",
    proposerId: "planner",
    parentRelease: "agentpool-v4.2",
    releaseId: "candidate",
    moduleHash,
    manifestHash,
    financeInvariantHash: engine.financeInvariantHash,
    canary,
  });
  for (const agentId of [
    "light",
    "validator-a",
    "validator-b",
    "validator-c",
    "planner",
  ]) {
    engine.voteEvolution(proposalId, {
      agentId,
      support: true,
      evidenceHash: digest(agentId),
    });
  }
  engine.finalizeEvolutionVote(proposalId);
  publishAndPlan(engine, {
    id: "candidate-job",
    kind: "EXTERNAL",
    releaseId: "candidate",
  });
  bidAndSettle(engine, "candidate-job");
  assert.throws(
    () =>
      engine.recordAdoption(proposalId, {
        agentId: "spectator",
        opportunityId: "candidate-job",
        outcomeHash: digest("fake-adoption"),
      }),
    /ADOPTER_DID_NOT_PARTICIPATE/,
  );
});

test("a proposer cannot self-report canary metrics without validator attestations", () => {
  const engine = buildEngine();
  publishAndPlan(engine, { id: "unattested-evolution" });
  bidAndSettle(engine, "unattested-evolution");
  assert.throws(
    () =>
      engine.proposeEvolution({
        opportunityId: "unattested-evolution",
        proposerId: "planner",
        parentRelease: "agentpool-v4.2",
        releaseId: "unattested-candidate",
        moduleHash: digest("unattested-module"),
        manifestHash: digest("unattested-manifest"),
        financeInvariantHash: engine.financeInvariantHash,
        canary: {
          qualityBps: 10_000,
          baselineQualityBps: 1,
          cost: 1,
          baselineCost: 10_000,
          latencyMs: 1,
          baselineLatencyMs: 10_000,
          securityRegressions: 0,
        },
      }),
    /INSUFFICIENT_CANARY_ATTESTATIONS/,
  );
});
