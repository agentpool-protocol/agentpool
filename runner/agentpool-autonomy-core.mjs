import { createHash, randomUUID } from "node:crypto";
import { formatUnits, parseUnits } from "viem";

export const AUTONOMY_EVENT_TYPES = Object.freeze({
  opportunity: "AUTONOMY_OPPORTUNITY",
  plan: "AUTONOMY_PLAN",
  bid: "AUTONOMY_BID",
  award: "AUTONOMY_AWARD",
  validation: "AUTONOMY_VALIDATION",
  issue: "IMPROVEMENT_ISSUE",
  canary: "CANARY_RESULT",
  vote: "WORK_POWER_VOTE",
  gasRequest: "GAS_REQUEST",
  gasGrant: "GAS_GRANT",
});

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function autonomyDigest(value) {
  return `0x${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function buildTaskDag(opportunity) {
  if (
    opportunity?.schema !== "agentpool.autonomy.opportunity/v1" ||
    !plain(opportunity.task)
  ) {
    throw new Error("AUTONOMY_OPPORTUNITY_INVALID");
  }
  const requested = Array.isArray(opportunity.task.steps)
    ? opportunity.task.steps
    : [
        {
          id: "execute",
          capability: opportunity.capability,
          dependencies: [],
          task: opportunity.task,
          weight: 1,
        },
      ];
  if (requested.length === 0 || requested.length > 32) {
    throw new Error("AUTONOMY_DAG_SIZE_INVALID");
  }
  const seen = new Set();
  const tasks = requested.map((step, index) => {
    const id = String(step.id ?? `task-${index}`);
    if (!/^[a-zA-Z0-9._:-]{1,64}$/u.test(id) || seen.has(id)) {
      throw new Error("AUTONOMY_TASK_ID_INVALID");
    }
    seen.add(id);
    return {
      id,
      market:
        opportunity.market ??
        opportunity.kind ??
        opportunity.funding ??
        "UNKNOWN",
      capability: String(step.capability ?? opportunity.capability),
      dependencies: Array.isArray(step.dependencies)
        ? step.dependencies.map(String)
        : [],
      task: plain(step.task) ? step.task : step,
      weight: Math.max(1, Number(step.weight ?? 1)),
    };
  });
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!seen.has(dependency) || dependency === task.id) {
        throw new Error("AUTONOMY_DAG_DEPENDENCY_INVALID");
      }
    }
  }
  const totalWeight = tasks.reduce((sum, task) => sum + task.weight, 0);
  const maximum = parseUnits(String(opportunity.maxBudgetApool), 18);
  let allocated = 0n;
  const budgeted = tasks.map((task, index) => {
    const budget =
      index === tasks.length - 1
        ? maximum - allocated
        : (maximum * BigInt(task.weight)) / BigInt(totalWeight);
    allocated += budget;
    return { ...task, maxBudgetBaseUnits: budget.toString() };
  });
  const plan = {
    schema: "agentpool.autonomy.plan/v1",
    opportunityId: opportunity.id,
    planId: `plan:${randomUUID()}`,
    tasks: budgeted,
    maxBudgetBaseUnits: maximum.toString(),
  };
  return { ...plan, planHash: autonomyDigest(plan) };
}

export function createRiskAdjustedBid(task, profile) {
  const maximum = BigInt(task.maxBudgetBaseUnits);
  const minimum = parseUnits(
    String(profile.minimumPriceApool ?? profile.priceApool ?? "0"),
    18,
  );
  const shareBps = BigInt(
    Math.max(0, Math.min(10_000, Number(profile.bidShareBps ?? 0))),
  );
  const shared = shareBps > 0n
    ? (maximum * shareBps) / 10_000n
    : minimum;
  const configuredMaximum = profile.maximumPriceApool === undefined
    ? maximum
    : parseUnits(String(profile.maximumPriceApool), 18);
  if (minimum > maximum) {
    throw new Error("AUTONOMY_BID_EXCEEDS_TASK_BUDGET");
  }
  const price = [maximum, configuredMaximum]
    .reduce((lowest, value) => (value < lowest ? value : lowest), maximum);
  const quotedPrice = shared > price ? price : shared < minimum ? minimum : shared;
  const success = BigInt(
    Math.max(1, Math.min(10_000, Number(profile.successLowerBps))),
  );
  const latencyPenalty = parseUnits(
    String(profile.latencyPenaltyApool ?? "0"),
    18,
  );
  const failureLoss = parseUnits(
    String(profile.failureLossApool ?? "0"),
    18,
  );
  const concentration = parseUnits(
    String(profile.concentrationPenaltyApool ?? "0"),
    18,
  );
  const estimatedCost = parseUnits(
    String(profile.estimatedCostApool ?? "0"),
    18,
  );
  const estimatedGas = parseUnits(
    String(profile.estimatedGasApool ?? "0"),
    18,
  );
  const riskAdjusted =
    (quotedPrice * 10_000n) / success +
    latencyPenalty +
    (failureLoss * (10_000n - success)) / 10_000n +
    concentration;
  if (quotedPrice > maximum) {
    throw new Error("AUTONOMY_BID_EXCEEDS_TASK_BUDGET");
  }
  const expectedNetProfit =
    (quotedPrice * success) / 10_000n -
    estimatedCost -
    estimatedGas -
    (failureLoss * (10_000n - success)) / 10_000n -
    concentration;
  return {
    schema: "agentpool.autonomy.bid/v1",
    taskId: task.id,
    market: task.market ?? null,
    capability: task.capability,
    provider: profile.provider,
    bidderAddress: profile.bidderAddress,
    operatorGroup: profile.operatorGroup,
    priceBaseUnits: quotedPrice.toString(),
    riskAdjustedBaseUnits: riskAdjusted.toString(),
    expectedNetProfitBaseUnits: expectedNetProfit.toString(),
    expectedNetProfitApool: formatUnits(expectedNetProfit, 18),
    successLowerBps: Number(success),
    capacityUnits: Number(profile.capacityUnits ?? 1),
    expiresAt: Number(profile.expiresAt),
  };
}

export function rankWorkChoicesByExpectedNetProfit(
  choices,
  { minimumNetProfitApool = "0", capacityUnits = 1 } = {},
) {
  const minimum = parseUnits(String(minimumNetProfitApool), 18);
  const capacity = Math.max(0, Number(capacityUnits));
  return choices
    .filter((choice) => choice && typeof choice === "object")
    .map((choice) => {
      const reward = parseUnits(String(choice.rewardApool ?? "0"), 18);
      const success = BigInt(
        Math.max(
          1,
          Math.min(10_000, Number(choice.successProbabilityBps ?? 10_000)),
        ),
      );
      const estimatedCost = parseUnits(
        String(choice.estimatedCostApool ?? "0"),
        18,
      );
      const estimatedGas = parseUnits(
        String(choice.estimatedGasApool ?? "0"),
        18,
      );
      const failureLoss = parseUnits(
        String(choice.failureLossApool ?? "0"),
        18,
      );
      const opportunityCost = parseUnits(
        String(choice.opportunityCostApool ?? "0"),
        18,
      );
      const expectedNet =
        (reward * success) / 10_000n -
        estimatedCost -
        estimatedGas -
        (failureLoss * (10_000n - success)) / 10_000n -
        opportunityCost;
      return {
        ...choice,
        expectedNetProfitBaseUnits: expectedNet.toString(),
        expectedNetProfitApool: formatUnits(expectedNet, 18),
      };
    })
    .filter(
      (choice) =>
        BigInt(choice.expectedNetProfitBaseUnits) >= minimum,
    )
    .sort((left, right) => {
      const profit =
        BigInt(right.expectedNetProfitBaseUnits) -
        BigInt(left.expectedNetProfitBaseUnits);
      if (profit !== 0n) return profit > 0n ? 1 : -1;
      return String(left.id).localeCompare(String(right.id));
    })
    .slice(0, capacity);
}

export function selectWinningBids(plan, bids) {
  const selected = [];
  const reservedByBidder = new Map();
  for (const task of plan.tasks) {
    const eligible = bids
      .filter(
        (bid) =>
          bid.taskId === task.id &&
          bid.capability === task.capability &&
          Number(bid.expiresAt) > Date.now(),
      )
      .filter((bid) => {
        const used = reservedByBidder.get(bid.bidderAddress) ?? 0;
        return used < Number(bid.capacityUnits);
      })
      .sort((left, right) => {
        const risk =
          BigInt(left.riskAdjustedBaseUnits) -
          BigInt(right.riskAdjustedBaseUnits);
        if (risk !== 0n) return risk < 0n ? -1 : 1;
        return String(left.bidderAddress).localeCompare(
          String(right.bidderAddress),
        );
      });
    if (eligible.length === 0) {
      throw new Error(`AUTONOMY_NO_ELIGIBLE_BID:${task.id}`);
    }
    const winner = eligible[0];
    reservedByBidder.set(
      winner.bidderAddress,
      (reservedByBidder.get(winner.bidderAddress) ?? 0) + 1,
    );
    selected.push({ taskId: task.id, ...winner });
  }
  const total = selected.reduce(
    (sum, bid) => sum + BigInt(bid.priceBaseUnits),
    0n,
  );
  if (total > BigInt(plan.maxBudgetBaseUnits)) {
    throw new Error("AUTONOMY_AWARD_EXCEEDS_PLAN_BUDGET");
  }
  return {
    schema: "agentpool.autonomy.award/v1",
    planId: plan.planId,
    planHash: plan.planHash,
    selected,
    reservedBaseUnits: total.toString(),
  };
}

export function validateExecutionResult({
  result,
  policy,
  deterministicExpected,
}) {
  if (
    result?.schema !== "agentpool.executor.result/v1" ||
    typeof result.content !== "string"
  ) {
    return { passed: false, scoreBps: 0, reason: "RESULT_SCHEMA_INVALID" };
  }
  if (policy === "EXACT") {
    const passed = result.content === deterministicExpected;
    return {
      passed,
      scoreBps: passed ? 10_000 : 0,
      reason: passed ? "EXACT_MATCH" : "EXACT_MISMATCH",
    };
  }
  if (policy === "NONEMPTY") {
    const passed = result.content.trim().length > 0;
    return {
      passed,
      scoreBps: passed ? 8_000 : 0,
      reason: passed ? "NONEMPTY" : "EMPTY",
    };
  }
  throw new Error("AUTONOMY_VALIDATION_POLICY_UNSUPPORTED");
}

export function evaluateCanary(candidate, baseline, thresholds = {}) {
  const qualityGain =
    Number(candidate.qualityBps) - Number(baseline.qualityBps);
  const costSavingBps =
    baseline.cost > 0
      ? Math.floor(
          ((Number(baseline.cost) - Number(candidate.cost)) * 10_000) /
            Number(baseline.cost),
        )
      : 0;
  const latencySavingBps =
    baseline.latencyMs > 0
      ? Math.floor(
          ((Number(baseline.latencyMs) -
            Number(candidate.latencyMs)) *
            10_000) /
            Number(baseline.latencyMs),
        )
      : 0;
  const passed =
    Number(candidate.securityRegressions ?? 0) === 0 &&
    qualityGain >= Number(thresholds.minimumQualityGainBps ?? 0) &&
    costSavingBps >= Number(thresholds.minimumCostSavingBps ?? -10_000) &&
    latencySavingBps >=
      Number(thresholds.minimumLatencySavingBps ?? -10_000);
  return {
    passed,
    qualityGainBps: qualityGain,
    costSavingBps,
    latencySavingBps,
    reason: passed ? "CANARY_PROVEN" : "CANARY_REJECTED",
  };
}

export function detectImprovementIssues(metrics, rules = {}) {
  const issues = [];
  const checks = [
    {
      key: "errorRateBps",
      threshold: Number(rules.maximumErrorRateBps ?? 500),
      direction: "max",
      issue: "RUNNER_ERROR_RATE",
    },
    {
      key: "p95LatencyMs",
      threshold: Number(rules.maximumP95LatencyMs ?? 30_000),
      direction: "max",
      issue: "RUNNER_P95_LATENCY",
    },
    {
      key: "stuckJobs",
      threshold: Number(rules.maximumStuckJobs ?? 0),
      direction: "max",
      issue: "STUCK_JOB_RECOVERY",
    },
    {
      key: "securityRegressions",
      threshold: Number(rules.maximumSecurityRegressions ?? 0),
      direction: "max",
      issue: "SECURITY_REGRESSION",
    },
  ];
  for (const check of checks) {
    const observed = Number(metrics?.[check.key] ?? 0);
    if (check.direction === "max" && observed > check.threshold) {
      issues.push({
        issueType: check.issue,
        metric: check.key,
        observed,
        threshold: check.threshold,
      });
    }
  }
  return issues;
}

export function decideWorkPowerVote(votes, {
  eligiblePower,
  minimumParticipants = 5,
  minimumGroups = 3,
  quorumBps = 3_000,
  supportBps = 6_667,
  perAgentCapBps = 1_000,
}) {
  const cap = (BigInt(eligiblePower) * BigInt(perAgentCapBps)) / 10_000n;
  const unique = new Map();
  for (const vote of votes) {
    if (!unique.has(vote.agentId)) unique.set(vote.agentId, vote);
  }
  const normalized = [...unique.values()].map((vote) => ({
    ...vote,
    effectivePower:
      BigInt(vote.power) > cap ? cap : BigInt(vote.power),
  }));
  const participation = normalized.reduce(
    (sum, vote) => sum + vote.effectivePower,
    0n,
  );
  const support = normalized
    .filter((vote) => vote.support)
    .reduce((sum, vote) => sum + vote.effectivePower, 0n);
  const groups = new Set(normalized.map((vote) => vote.operatorGroup));
  const quorumReached =
    participation * 10_000n >=
    BigInt(eligiblePower) * BigInt(quorumBps);
  const supportReached =
    participation > 0n &&
    support * 10_000n >= participation * BigInt(supportBps);
  return {
    approved:
      normalized.length >= minimumParticipants &&
      groups.size >= minimumGroups &&
      quorumReached &&
      supportReached,
    participants: normalized.length,
    groups: groups.size,
    participation: participation.toString(),
    support: support.toString(),
    quorumReached,
    supportReached,
  };
}

export function gasDecision({
  balanceWei,
  minimumBalanceWei,
  estimatedTransactionWei,
  sponsorBudgetWei = 0n,
}) {
  const balance = BigInt(balanceWei);
  const minimum = BigInt(minimumBalanceWei);
  const estimated = BigInt(estimatedTransactionWei);
  const sponsor = BigInt(sponsorBudgetWei);
  if (balance >= minimum + estimated) {
    return { state: "SELF_FUNDED", requestedWei: "0" };
  }
  const requested = minimum + estimated - balance;
  if (requested <= sponsor) {
    return { state: "SPONSOR_ELIGIBLE", requestedWei: requested.toString() };
  }
  return { state: "GAS_HOLD", requestedWei: requested.toString() };
}
