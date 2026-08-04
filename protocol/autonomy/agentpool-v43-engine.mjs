import crypto from "node:crypto";

const BPS = 10_000;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `0x${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function median(values) {
  invariant(values.length > 0, "EMPTY_MEDIAN");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function clampInteger(value, minimum, maximum, code) {
  invariant(Number.isSafeInteger(value), code);
  invariant(value >= minimum && value <= maximum, code);
  return value;
}

function unique(values) {
  return new Set(values).size === values.length;
}

function verifiedSuccessBps(profile) {
  return Math.max(
    1,
    Math.min(
      BPS,
      Math.floor(
        ((profile.successes + 2) * BPS) /
          (profile.attempts + 4),
      ),
    ),
  );
}

function refreshVerifiedPerformance(profile) {
  profile.verifiedSuccessBps = verifiedSuccessBps(profile);
}

function assertDag(tasks) {
  const ids = tasks.map((task) => task.id);
  invariant(unique(ids), "DUPLICATE_TASK_ID");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    invariant(
      task.dependencies.every((dependency) => byId.has(dependency)),
      "UNKNOWN_TASK_DEPENDENCY",
    );
    invariant(!task.dependencies.includes(task.id), "SELF_DEPENDENCY");
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    invariant(!visiting.has(id), "CYCLIC_TASK_GRAPH");
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function roleKey(taskId, role) {
  return `${taskId}:${role}`;
}

export class AgentPoolV43Engine {
  constructor({
    financeInvariantHash = digest({
      maxSupply: "1000000000000",
      externalJobsMint: false,
      noArbitraryWithdrawal: true,
      noEvaluatorPayoutField: true,
      payoutNeverExceedsReservation: true,
    }),
    genesisRelease = "agentpool-v4.2",
    minRewardQuotes = 3,
    minEvolutionVoters = 5,
    minEvolutionGroups = 3,
    minAdoptions = 5,
    minAdoptionGroups = 3,
  } = {}) {
    this.financeInvariantHash = financeInvariantHash;
    this.minRewardQuotes = minRewardQuotes;
    this.minEvolutionVoters = minEvolutionVoters;
    this.minEvolutionGroups = minEvolutionGroups;
    this.minAdoptions = minAdoptions;
    this.minAdoptionGroups = minAdoptionGroups;
    this.agents = new Map();
    this.opportunities = new Map();
    this.releases = new Map([
      [
        genesisRelease,
        {
          id: genesisRelease,
          parent: null,
          state: "RECOMMENDED",
          financeInvariantHash,
          moduleHash: digest(genesisRelease),
          proposalId: null,
        },
      ],
    ]);
    this.proposals = new Map();
    this.recommendedRelease = genesisRelease;
    this.balances = new Map();
    this.slashPool = 0;
    this.sequence = 1;
  }

  registerAgent({
    id,
    address,
    operatorGroup,
    runtimeHash,
    capabilities,
    capacity = 1,
  }) {
    invariant(id && address && operatorGroup && runtimeHash, "INVALID_AGENT");
    invariant(!this.agents.has(id), "AGENT_EXISTS");
    clampInteger(capacity, 1, 1_000, "INVALID_CAPACITY");
    invariant(Array.isArray(capabilities) && capabilities.length > 0, "NO_CAPABILITY");
    const profiles = {};
    for (const profile of capabilities) {
      invariant(profile.track, "INVALID_CAPABILITY");
      profiles[profile.track] = {
        declaredSuccessBps: clampInteger(
          profile.successLowerBps ?? 5_000,
          1,
          BPS,
          "INVALID_DECLARED_SUCCESS",
        ),
        p95LatencyMs: clampInteger(
          profile.p95LatencyMs,
          0,
          Number.MAX_SAFE_INTEGER,
          "INVALID_LATENCY",
        ),
        costFloor: clampInteger(
          profile.costFloor,
          0,
          Number.MAX_SAFE_INTEGER,
          "INVALID_COST_FLOOR",
        ),
        attempts: 0,
        successes: 0,
        verifiedSuccessBps: 5_000,
      };
    }
    this.agents.set(id, {
      id,
      address,
      operatorGroup,
      runtimeHash,
      profiles,
      capacity,
      heldCapacity: 0,
      workPower: 0,
      successfulWork: 0,
      attemptedWork: 0,
      slashCount: 0,
    });
    this.balances.set(id, 0);
    return this.agent(id);
  }

  publishOpportunity({
    id = `op-${this.sequence++}`,
    kind,
    creator,
    specificationHash,
    maxBudget,
    releaseId = this.recommendedRelease,
    minScoreBps = 7_000,
    deadline,
    externalDeposit = 0,
    systemEmissionCap = 0,
  }) {
    invariant(kind === "EXTERNAL" || kind === "SYSTEM_IMPROVEMENT", "INVALID_KIND");
    invariant(!this.opportunities.has(id), "OPPORTUNITY_EXISTS");
    const release = this.releases.get(releaseId);
    invariant(release, "UNKNOWN_RELEASE");
    invariant(
      release.state === "PROVEN" || release.state === "RECOMMENDED",
      "RELEASE_NOT_PROVEN",
    );
    invariant(specificationHash, "INVALID_SPECIFICATION");
    clampInteger(maxBudget, 1, Number.MAX_SAFE_INTEGER, "INVALID_BUDGET");
    clampInteger(deadline, 1, Number.MAX_SAFE_INTEGER, "INVALID_DEADLINE");
    clampInteger(minScoreBps, 1, BPS, "INVALID_SCORE");
    if (kind === "EXTERNAL") {
      invariant(externalDeposit === maxBudget, "EXTERNAL_BUDGET_NOT_ESCROWED");
      invariant(systemEmissionCap === 0, "EXTERNAL_JOB_CANNOT_EMIT");
    } else {
      invariant(externalDeposit === 0, "SYSTEM_JOB_CANNOT_USE_BUYER_ESCROW");
      invariant(systemEmissionCap === maxBudget, "SYSTEM_CAP_NOT_RESERVED");
    }
    const opportunity = {
      id,
      kind,
      creator,
      specificationHash,
      maxBudget,
      releaseId,
      minScoreBps,
      deadline,
      state: "PLANNING",
      escrowed: externalDeposit,
      emissionReserved: systemEmissionCap,
      minted: 0,
      spent: 0,
      refunded: 0,
      plans: [],
      rewardQuotes: [],
      selectedPlanId: null,
      tasks: new Map(),
      pendingPayouts: new Map(),
      settledPayouts: new Map(),
      quotePayouts: new Map(),
      canaryAttestations: new Map(),
      history: [],
    };
    this.opportunities.set(id, opportunity);
    return this.opportunity(id);
  }

  submitRewardQuote(opportunityId, {
    agentId,
    amount,
    riskBps,
    feeAsk,
    evidenceHash,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "PLANNING", "QUOTE_WINDOW_CLOSED");
    const agent = this.#agent(agentId);
    invariant(agent.profiles.pricing, "AGENT_LACKS_PRICING_CAPABILITY");
    invariant(
      !opportunity.rewardQuotes.some((quote) => quote.agentId === agentId),
      "DUPLICATE_REWARD_QUOTE",
    );
    clampInteger(amount, 1, opportunity.maxBudget, "INVALID_QUOTE_AMOUNT");
    clampInteger(riskBps, 0, BPS, "INVALID_QUOTE_RISK");
    clampInteger(feeAsk, 1, opportunity.maxBudget, "INVALID_QUOTE_FEE");
    invariant(evidenceHash, "INVALID_QUOTE_EVIDENCE");
    opportunity.rewardQuotes.push({
      agentId,
      amount,
      riskBps,
      feeAsk,
      evidenceHash,
      paid: false,
    });
  }

  submitPlan(opportunityId, {
    id = `plan-${this.sequence++}`,
    plannerId,
    tasks,
    plannerFee,
    pricingBudget,
    contingency,
    totalBid,
    bond,
    planHash,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "PLANNING", "PLAN_WINDOW_CLOSED");
    const planner = this.#agent(plannerId);
    invariant(planner.profiles.planning, "AGENT_LACKS_PLANNING_CAPABILITY");
    invariant(tasks.length > 0 && tasks.length <= 64, "INVALID_TASK_COUNT");
    assertDag(tasks);
    for (const task of tasks) {
      invariant(task.capability, "INVALID_TASK_CAPABILITY");
      clampInteger(task.maxBudget, 1, opportunity.maxBudget, "INVALID_TASK_BUDGET");
      clampInteger(task.minValidators, 1, 7, "INVALID_VALIDATOR_COUNT");
      invariant(task.minValidators % 2 === 1, "VALIDATOR_COUNT_MUST_BE_ODD");
      clampInteger(task.minScoreBps, 1, BPS, "INVALID_TASK_SCORE");
      clampInteger(task.deadline, 1, opportunity.deadline, "INVALID_TASK_DEADLINE");
    }
    const calculated =
      tasks.reduce((sum, task) => sum + task.maxBudget, 0) +
      plannerFee +
      pricingBudget +
      contingency;
    invariant(calculated === totalBid, "PLAN_TOTAL_MISMATCH");
    invariant(totalBid <= opportunity.maxBudget, "PLAN_EXCEEDS_BUDGET");
    clampInteger(bond, 1, opportunity.maxBudget, "INVALID_PLAN_BOND");
    invariant(planHash === digest({ tasks, plannerFee, pricingBudget, contingency }), "PLAN_HASH_MISMATCH");
    opportunity.plans.push({
      id,
      plannerId,
      tasks: structuredClone(tasks),
      plannerFee,
      pricingBudget,
      contingency,
      totalBid,
      bond,
      planHash,
      selected: false,
    });
    return id;
  }

  awardPlan(opportunityId) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "PLANNING", "PLAN_ALREADY_AWARDED");
    invariant(
      opportunity.rewardQuotes.length >= this.minRewardQuotes,
      "INSUFFICIENT_REWARD_QUOTES",
    );
    invariant(
      new Set(
        opportunity.rewardQuotes.map(
          (quote) => this.#agent(quote.agentId).operatorGroup,
        ),
      ).size >= this.minRewardQuotes,
      "INSUFFICIENT_QUOTE_DIVERSITY",
    );
    invariant(opportunity.plans.length > 0, "NO_PLANS");
    const quoteMedian = median(opportunity.rewardQuotes.map((quote) => quote.amount));
    const quoteCeiling = Math.min(
      opportunity.maxBudget,
      Math.floor((quoteMedian * 12_500) / BPS),
    );
    const eligible = opportunity.plans
      .filter((plan) => plan.totalBid <= quoteCeiling)
      .map((plan) => {
        const planner = this.#agent(plan.plannerId);
        const profile = planner.profiles.planning;
        const success = verifiedSuccessBps(profile);
        const failureRisk = Math.floor(
          ((BPS - success) * plan.totalBid) / BPS,
        );
        const riskAdjustedCost =
          Math.ceil((plan.totalBid * BPS) / success) +
          failureRisk +
          Math.ceil(profile.p95LatencyMs / 1_000);
        return { plan, riskAdjustedCost };
      })
      .sort(
        (a, b) =>
          a.riskAdjustedCost - b.riskAdjustedCost ||
          a.plan.totalBid - b.plan.totalBid ||
          a.plan.id.localeCompare(b.plan.id),
      );
    invariant(eligible.length > 0, "NO_PLAN_WITHIN_MARKET_QUOTE");
    const selected = eligible[0].plan;
    selected.selected = true;
    opportunity.selectedPlanId = selected.id;
    opportunity.state = "BIDDING";
    for (const specification of selected.tasks) {
      opportunity.tasks.set(specification.id, {
        ...structuredClone(specification),
        state: "OPEN",
        bids: new Map(),
        allocation: null,
        delivery: null,
        evaluations: [],
        settledAmount: 0,
      });
    }
    opportunity.history.push({
      event: "PLAN_AWARDED",
      planId: selected.id,
      quoteMedian,
      quoteCeiling,
    });
    return selected.id;
  }

  submitRoleBid(opportunityId, taskId, {
    agentId,
    role,
    price,
    durationMs,
    bond,
    nonce,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "BIDDING" || opportunity.state === "RUNNING", "BIDDING_CLOSED");
    const task = this.#task(opportunity, taskId);
    invariant(task.state === "OPEN", "TASK_NOT_OPEN");
    invariant(role === "WORKER" || role === "VALIDATOR", "INVALID_ROLE");
    const agent = this.#agent(agentId);
    const track = role === "WORKER" ? task.capability : "validation";
    invariant(agent.profiles[track], "AGENT_LACKS_ROLE_CAPABILITY");
    invariant(agent.heldCapacity < agent.capacity, "AGENT_CAPACITY_EXHAUSTED");
    clampInteger(price, 1, task.maxBudget, "INVALID_BID_PRICE");
    clampInteger(durationMs, 1, Number.MAX_SAFE_INTEGER, "INVALID_BID_DURATION");
    clampInteger(bond, 1, opportunity.maxBudget, "INVALID_BID_BOND");
    const key = roleKey(taskId, role);
    if (!task.bids.has(key)) task.bids.set(key, []);
    const bids = task.bids.get(key);
    invariant(!bids.some((bid) => bid.agentId === agentId), "DUPLICATE_ROLE_BID");
    bids.push({
      agentId,
      role,
      price,
      durationMs,
      bond,
      commitment: digest({ opportunityId, taskId, agentId, role, price, durationMs, bond, nonce }),
    });
  }

  allocateReadyTasks(opportunityId) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "BIDDING" || opportunity.state === "RUNNING", "NOT_ALLOCATABLE");
    let allocated = 0;
    for (const task of opportunity.tasks.values()) {
      if (task.state !== "OPEN") continue;
      const dependenciesReady = task.dependencies.every(
        (dependency) => opportunity.tasks.get(dependency)?.state === "SETTLED",
      );
      if (!dependenciesReady) continue;
      const workerBids = task.bids.get(roleKey(task.id, "WORKER")) ?? [];
      const validatorBids = task.bids.get(roleKey(task.id, "VALIDATOR")) ?? [];
      const workers = this.#rankBids(workerBids, task.capability);
      const validators = this.#rankBids(validatorBids, "validation");
      const worker = workers[0];
      if (!worker) continue;
      const independentValidators = [];
      const plan = this.#selectedPlan(opportunity);
      const usedGroups = new Set([
        this.#agent(worker.agentId).operatorGroup,
        this.#agent(plan.plannerId).operatorGroup,
      ]);
      for (const bid of validators) {
        const group = this.#agent(bid.agentId).operatorGroup;
        if (usedGroups.has(group)) continue;
        usedGroups.add(group);
        independentValidators.push(bid);
        if (independentValidators.length === task.minValidators) break;
      }
      if (independentValidators.length !== task.minValidators) continue;
      const total =
        worker.price +
        independentValidators.reduce((sum, bid) => sum + bid.price, 0);
      if (total > task.maxBudget) {
        task.state = "BUDGET_HOLD";
        opportunity.state = "REPLAN_REQUIRED";
        opportunity.history.push({ event: "BUDGET_HOLD", taskId: task.id, required: total });
        continue;
      }
      const participants = [worker, ...independentValidators];
      if (
        participants.some(
          (bid) => this.#agent(bid.agentId).heldCapacity >= this.#agent(bid.agentId).capacity,
        )
      ) continue;
      for (const bid of participants) this.#agent(bid.agentId).heldCapacity += 1;
      task.allocation = { worker, validators: independentValidators, total };
      task.state = "AWARDED";
      opportunity.state = "RUNNING";
      allocated += 1;
    }
    return allocated;
  }

  deliverTask(opportunityId, taskId, {
    agentId,
    artifactHash,
    evidenceHash,
    actualUsage = 1,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    const task = this.#task(opportunity, taskId);
    invariant(task.state === "AWARDED", "TASK_NOT_AWARDED");
    invariant(task.allocation.worker.agentId === agentId, "NOT_ALLOCATED_WORKER");
    invariant(artifactHash && evidenceHash, "INVALID_DELIVERY");
    clampInteger(actualUsage, 1, Number.MAX_SAFE_INTEGER, "INVALID_USAGE");
    task.delivery = { artifactHash, evidenceHash, actualUsage };
    task.state = "DELIVERED";
  }

  evaluateTask(opportunityId, taskId, submission) {
    invariant(!Object.hasOwn(submission, "payoutAmount"), "EVALUATOR_CANNOT_SET_PAYOUT");
    const opportunity = this.#opportunity(opportunityId);
    const task = this.#task(opportunity, taskId);
    invariant(task.state === "DELIVERED" || task.state === "EVALUATING", "TASK_NOT_DELIVERED");
    const { agentId, scoreBps, evidenceHash, objectivePassed } = submission;
    invariant(
      task.allocation.validators.some((validator) => validator.agentId === agentId),
      "NOT_ALLOCATED_VALIDATOR",
    );
    invariant(
      !task.evaluations.some((evaluation) => evaluation.agentId === agentId),
      "DUPLICATE_EVALUATION",
    );
    clampInteger(scoreBps, 0, BPS, "INVALID_EVALUATION_SCORE");
    invariant(evidenceHash, "INVALID_EVALUATION_EVIDENCE");
    task.evaluations.push({ agentId, scoreBps, evidenceHash, objectivePassed: Boolean(objectivePassed) });
    task.state = "EVALUATING";
  }

  settleTask(opportunityId, taskId) {
    const opportunity = this.#opportunity(opportunityId);
    const task = this.#task(opportunity, taskId);
    invariant(task.state === "EVALUATING", "TASK_NOT_EVALUATED");
    invariant(task.evaluations.length === task.minValidators, "VALIDATOR_QUORUM_MISSING");
    const objectivePasses = task.evaluations.filter((evaluation) => evaluation.objectivePassed).length;
    const score = median(task.evaluations.map((evaluation) => evaluation.scoreBps));
    const passed =
      objectivePasses > task.evaluations.length / 2 &&
      score >= task.minScoreBps;
    const participants = [
      task.allocation.worker,
      ...task.allocation.validators,
    ];
    for (const bid of participants) {
      const agent = this.#agent(bid.agentId);
      agent.heldCapacity -= 1;
      agent.attemptedWork += 1;
      const track = bid.role === "WORKER" ? task.capability : "validation";
      agent.profiles[track].attempts += 1;
    }
    if (!passed) {
      const worker = this.#agent(task.allocation.worker.agentId);
      worker.slashCount += 1;
      this.slashPool += task.allocation.worker.bond;
      for (const evaluation of task.evaluations) {
        if (!evaluation.objectivePassed) {
          const validator = this.#agent(evaluation.agentId);
          validator.successfulWork += 1;
          validator.profiles.validation.successes += 1;
        }
      }
      for (const bid of participants) {
        const agent = this.#agent(bid.agentId);
        const track =
          bid.role === "WORKER" ? task.capability : "validation";
        refreshVerifiedPerformance(agent.profiles[track]);
      }
      task.state = "FAILED";
      opportunity.state = "REPLAN_REQUIRED";
      opportunity.history.push({ event: "TASK_FAILED", taskId, score });
      return { passed: false, score };
    }
    const worker = this.#agent(task.allocation.worker.agentId);
    worker.successfulWork += 1;
    worker.profiles[task.capability].successes += 1;
    refreshVerifiedPerformance(worker.profiles[task.capability]);
    for (const evaluation of task.evaluations) {
      const validator = this.#agent(evaluation.agentId);
      if (evaluation.objectivePassed) {
        validator.successfulWork += 1;
        validator.profiles.validation.successes += 1;
      }
      refreshVerifiedPerformance(validator.profiles.validation);
    }
    for (const bid of participants) {
      opportunity.pendingPayouts.set(
        bid.agentId,
        (opportunity.pendingPayouts.get(bid.agentId) ?? 0) + bid.price,
      );
    }
    task.settledAmount = task.allocation.total;
    task.state = "SETTLED";
    opportunity.history.push({ event: "TASK_SETTLED", taskId, score });
    return { passed: true, score };
  }

  replanOpportunity(opportunityId, {
    plannerId,
    replacementTasks,
    reasonHash,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "REPLAN_REQUIRED", "REPLAN_NOT_REQUIRED");
    const plan = this.#selectedPlan(opportunity);
    invariant(plan.plannerId === plannerId, "ONLY_SELECTED_PLANNER_CAN_REPLAN");
    invariant(reasonHash, "INVALID_REPLAN_REASON");
    assertDag(replacementTasks);
    for (const task of replacementTasks) {
      invariant(task.capability, "INVALID_TASK_CAPABILITY");
      clampInteger(task.maxBudget, 1, opportunity.maxBudget, "INVALID_TASK_BUDGET");
      clampInteger(task.minValidators, 1, 7, "INVALID_VALIDATOR_COUNT");
      invariant(task.minValidators % 2 === 1, "VALIDATOR_COUNT_MUST_BE_ODD");
      clampInteger(task.minScoreBps, 1, BPS, "INVALID_TASK_SCORE");
      clampInteger(task.deadline, 1, opportunity.deadline, "INVALID_TASK_DEADLINE");
    }
    const alreadyCommitted =
      [...opportunity.pendingPayouts.values()].reduce((sum, amount) => sum + amount, 0) +
      plan.plannerFee +
      plan.pricingBudget;
    const replacementCap = replacementTasks.reduce((sum, task) => sum + task.maxBudget, 0);
    invariant(alreadyCommitted + replacementCap <= opportunity.maxBudget, "REPLAN_EXCEEDS_REMAINING_BUDGET");
    for (const [id, task] of opportunity.tasks) {
      if (task.state !== "SETTLED") opportunity.tasks.delete(id);
    }
    for (const task of replacementTasks) {
      opportunity.tasks.set(task.id, {
        ...structuredClone(task),
        state: "OPEN",
        bids: new Map(),
        allocation: null,
        delivery: null,
        evaluations: [],
        settledAmount: 0,
      });
    }
    opportunity.state = "BIDDING";
    opportunity.history.push({ event: "REPLANNED", reasonHash });
  }

  finalizeOpportunity(opportunityId) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(
      [...opportunity.tasks.values()].every((task) => task.state === "SETTLED"),
      "UNSETTLED_TASKS",
    );
    const plan = this.#selectedPlan(opportunity);
    opportunity.pendingPayouts.set(
      plan.plannerId,
      (opportunity.pendingPayouts.get(plan.plannerId) ?? 0) + plan.plannerFee,
    );
    const taskSpend = [...opportunity.pendingPayouts.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );
    const orderedQuotes = opportunity.rewardQuotes
      .map((quote) => ({ quote, error: Math.abs(quote.amount - taskSpend) }))
      .sort(
        (a, b) =>
          a.error - b.error ||
          a.quote.feeAsk - b.quote.feeAsk ||
          a.quote.agentId.localeCompare(b.quote.agentId),
      );
    let pricingSpend = 0;
    const rewardedQuoteGroups = new Set();
    for (const { quote } of orderedQuotes) {
      if (rewardedQuoteGroups.size === this.minRewardQuotes) break;
      const group = this.#agent(quote.agentId).operatorGroup;
      if (rewardedQuoteGroups.has(group)) continue;
      if (pricingSpend + quote.feeAsk > plan.pricingBudget) continue;
      rewardedQuoteGroups.add(group);
      quote.paid = true;
      pricingSpend += quote.feeAsk;
      opportunity.pendingPayouts.set(
        quote.agentId,
        (opportunity.pendingPayouts.get(quote.agentId) ?? 0) + quote.feeAsk,
      );
      opportunity.quotePayouts.set(quote.agentId, quote.feeAsk);
    }
    const total = [...opportunity.pendingPayouts.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );
    invariant(total <= opportunity.maxBudget, "SETTLEMENT_EXCEEDS_RESERVATION");
    for (const [agentId, amount] of opportunity.pendingPayouts) {
      opportunity.settledPayouts.set(agentId, amount);
      this.balances.set(agentId, (this.balances.get(agentId) ?? 0) + amount);
      const agent = this.#agent(agentId);
      agent.workPower += amount;
      if (agent.attemptedWork === 0) {
        agent.attemptedWork = 1;
        agent.successfulWork = 1;
      }
    }
    opportunity.spent = total;
    if (opportunity.kind === "SYSTEM_IMPROVEMENT") {
      opportunity.minted = Math.max(0, total - Math.min(total, this.slashPool));
      this.slashPool = Math.max(0, this.slashPool - total);
      opportunity.emissionReserved = 0;
    } else {
      opportunity.minted = 0;
      opportunity.refunded = opportunity.escrowed - total;
      opportunity.escrowed = 0;
    }
    opportunity.pendingPayouts.clear();
    opportunity.state = "SETTLED";
    opportunity.history.push({ event: "OPPORTUNITY_SETTLED", total });
    return {
      total,
      minted: opportunity.minted,
      refunded: opportunity.refunded,
      payouts: Object.fromEntries(opportunity.settledPayouts),
    };
  }

  attestCanary(opportunityId, {
    agentId,
    moduleHash,
    manifestHash,
    evidenceHash,
    metrics,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.kind === "SYSTEM_IMPROVEMENT", "CANARY_REQUIRES_SYSTEM_WORK");
    invariant(opportunity.state === "SETTLED", "CANARY_WORK_NOT_SETTLED");
    const agent = this.#agent(agentId);
    invariant(agent.profiles.validation, "CANARY_REQUIRES_VALIDATOR");
    invariant(
      opportunity.settledPayouts.has(agentId),
      "CANARY_VALIDATOR_DID_NOT_PARTICIPATE",
    );
    invariant(
      !opportunity.canaryAttestations.has(agentId),
      "DUPLICATE_CANARY_ATTESTATION",
    );
    invariant(moduleHash && manifestHash && evidenceHash, "INVALID_CANARY_EVIDENCE");
    clampInteger(metrics.qualityBps, 0, BPS, "INVALID_CANARY_QUALITY");
    clampInteger(
      metrics.baselineQualityBps,
      0,
      BPS,
      "INVALID_CANARY_BASELINE_QUALITY",
    );
    clampInteger(metrics.cost, 0, Number.MAX_SAFE_INTEGER, "INVALID_CANARY_COST");
    clampInteger(
      metrics.baselineCost,
      1,
      Number.MAX_SAFE_INTEGER,
      "INVALID_CANARY_BASELINE_COST",
    );
    clampInteger(
      metrics.latencyMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "INVALID_CANARY_LATENCY",
    );
    clampInteger(
      metrics.baselineLatencyMs,
      1,
      Number.MAX_SAFE_INTEGER,
      "INVALID_CANARY_BASELINE_LATENCY",
    );
    clampInteger(
      metrics.securityRegressions,
      0,
      Number.MAX_SAFE_INTEGER,
      "INVALID_CANARY_SECURITY",
    );
    opportunity.canaryAttestations.set(agentId, {
      agentId,
      operatorGroup: agent.operatorGroup,
      moduleHash,
      manifestHash,
      evidenceHash,
      metrics: structuredClone(metrics),
    });
  }

  proposeEvolution({
    id = `evolution-${this.sequence++}`,
    opportunityId,
    proposerId,
    parentRelease,
    releaseId,
    moduleHash,
    manifestHash,
    financeInvariantHash,
    canary,
  }) {
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.kind === "SYSTEM_IMPROVEMENT", "ONLY_SYSTEM_WORK_CAN_EVOLVE");
    invariant(opportunity.state === "SETTLED", "IMPROVEMENT_NOT_SETTLED");
    invariant(this.agents.has(proposerId), "UNKNOWN_PROPOSER");
    invariant(this.releases.has(parentRelease), "UNKNOWN_PARENT_RELEASE");
    invariant(!this.releases.has(releaseId), "RELEASE_EXISTS");
    invariant(financeInvariantHash === this.financeInvariantHash, "FINANCE_INVARIANT_CHANGED");
    const attestations = [...opportunity.canaryAttestations.values()].filter(
      (attestation) =>
        attestation.moduleHash === moduleHash &&
        attestation.manifestHash === manifestHash,
    );
    invariant(attestations.length >= 3, "INSUFFICIENT_CANARY_ATTESTATIONS");
    invariant(
      new Set(attestations.map((attestation) => attestation.operatorGroup)).size >= 3,
      "INSUFFICIENT_CANARY_DIVERSITY",
    );
    const attestedCanary = {
      qualityBps: median(attestations.map((entry) => entry.metrics.qualityBps)),
      baselineQualityBps: median(
        attestations.map((entry) => entry.metrics.baselineQualityBps),
      ),
      cost: median(attestations.map((entry) => entry.metrics.cost)),
      baselineCost: median(
        attestations.map((entry) => entry.metrics.baselineCost),
      ),
      latencyMs: median(
        attestations.map((entry) => entry.metrics.latencyMs),
      ),
      baselineLatencyMs: median(
        attestations.map((entry) => entry.metrics.baselineLatencyMs),
      ),
      securityRegressions: Math.max(
        ...attestations.map((entry) => entry.metrics.securityRegressions),
      ),
    };
    invariant(
      digest(canary) === digest(attestedCanary),
      "CANARY_DOES_NOT_MATCH_ATTESTATIONS",
    );
    invariant(canary.securityRegressions === 0, "SECURITY_REGRESSION");
    invariant(canary.qualityBps >= canary.baselineQualityBps, "QUALITY_REGRESSION");
    invariant(
      canary.cost <= Math.floor((canary.baselineCost * 9_500) / BPS) ||
        canary.latencyMs <= Math.floor((canary.baselineLatencyMs * 9_500) / BPS),
      "NO_MEASURABLE_IMPROVEMENT",
    );
    this.proposals.set(id, {
      id,
      opportunityId,
      proposerId,
      parentRelease,
      releaseId,
      moduleHash,
      manifestHash,
      financeInvariantHash,
      canary: structuredClone(canary),
      state: "VOTING",
      votes: new Map(),
      yesWeight: 0,
      noWeight: 0,
      groups: new Set(),
      adoptions: new Map(),
      adoptionGroups: new Set(),
      snapshotTotalWork: [...this.agents.values()].reduce(
        (sum, agent) => sum + agent.workPower,
        0,
      ),
      snapshotWeights: new Map(
        [...this.agents.values()].map((agent) => {
          const reliability =
            agent.attemptedWork === 0
              ? 0
              : Math.floor((agent.successfulWork * BPS) / agent.attemptedWork);
          return [
            agent.id,
            Math.floor((agent.workPower * reliability) / BPS),
          ];
        }),
      ),
    });
    this.releases.set(releaseId, {
      id: releaseId,
      parent: parentRelease,
      state: "CANDIDATE",
      financeInvariantHash,
      moduleHash,
      proposalId: id,
    });
    return id;
  }

  voteEvolution(proposalId, { agentId, support, evidenceHash }) {
    const proposal = this.#proposal(proposalId);
    invariant(proposal.state === "VOTING", "VOTING_CLOSED");
    invariant(!proposal.votes.has(agentId), "DUPLICATE_EVOLUTION_VOTE");
    const agent = this.#agent(agentId);
    invariant(agent.successfulWork > 0, "NO_PROVEN_CONTRIBUTION");
    invariant(evidenceHash, "VOTE_EVIDENCE_REQUIRED");
    const uncapped = proposal.snapshotWeights.get(agentId) ?? 0;
    const cap = Math.max(1, Math.floor(proposal.snapshotTotalWork / 10));
    const weight = Math.min(uncapped, cap);
    invariant(weight > 0, "ZERO_VOTING_WEIGHT");
    proposal.votes.set(agentId, { support: Boolean(support), weight, evidenceHash });
    proposal.groups.add(agent.operatorGroup);
    if (support) proposal.yesWeight += weight;
    else proposal.noWeight += weight;
    return weight;
  }

  finalizeEvolutionVote(proposalId) {
    const proposal = this.#proposal(proposalId);
    invariant(proposal.state === "VOTING", "VOTING_CLOSED");
    invariant(proposal.votes.size >= this.minEvolutionVoters, "INSUFFICIENT_VOTERS");
    invariant(proposal.groups.size >= this.minEvolutionGroups, "INSUFFICIENT_OPERATOR_DIVERSITY");
    const cast = proposal.yesWeight + proposal.noWeight;
    invariant(
      cast * BPS >= proposal.snapshotTotalWork * 3_000,
      "CONTRIBUTION_QUORUM_NOT_MET",
    );
    invariant(proposal.yesWeight * BPS >= cast * 6_667, "SUPERMAJORITY_NOT_MET");
    proposal.state = "ADOPTION";
    this.releases.get(proposal.releaseId).state = "PROVEN";
  }

  recordAdoption(proposalId, {
    agentId,
    opportunityId,
    outcomeHash,
  }) {
    const proposal = this.#proposal(proposalId);
    invariant(proposal.state === "ADOPTION", "RELEASE_NOT_ADOPTABLE");
    invariant(!proposal.adoptions.has(agentId), "DUPLICATE_ADOPTION");
    const opportunity = this.#opportunity(opportunityId);
    invariant(opportunity.state === "SETTLED", "ADOPTION_JOB_NOT_SETTLED");
    invariant(opportunity.releaseId === proposal.releaseId, "JOB_NOT_PINNED_TO_CANDIDATE");
    invariant(
      opportunity.settledPayouts.has(agentId),
      "ADOPTER_DID_NOT_PARTICIPATE",
    );
    invariant(outcomeHash, "INVALID_ADOPTION_OUTCOME");
    const agent = this.#agent(agentId);
    proposal.adoptions.set(agentId, { opportunityId, outcomeHash });
    proposal.adoptionGroups.add(agent.operatorGroup);
    if (
      proposal.adoptions.size >= this.minAdoptions &&
      proposal.adoptionGroups.size >= this.minAdoptionGroups
    ) {
      proposal.state = "RECOMMENDED";
      const previous = this.releases.get(this.recommendedRelease);
      if (previous?.state === "RECOMMENDED") previous.state = "PROVEN";
      this.releases.get(proposal.releaseId).state = "RECOMMENDED";
      this.recommendedRelease = proposal.releaseId;
    }
  }

  opportunitiesFor(agentId) {
    const agent = this.#agent(agentId);
    return [...this.opportunities.values()]
      .filter((opportunity) => opportunity.state === "BIDDING" || opportunity.state === "RUNNING")
      .flatMap((opportunity) =>
        [...opportunity.tasks.values()]
          .filter((task) => task.state === "OPEN" && agent.profiles[task.capability])
          .map((task) => {
            const profile = agent.profiles[task.capability];
            const success = verifiedSuccessBps(profile);
            const expectedPayment = task.maxBudget;
            const expectedFailureLoss = profile.costFloor;
            const expectedProfit =
              Math.floor((success * expectedPayment) / BPS) -
              profile.costFloor -
              Math.floor(
                ((BPS - success) * expectedFailureLoss) / BPS,
              );
            return {
              opportunityId: opportunity.id,
              taskId: task.id,
              kind: opportunity.kind,
              expectedProfit,
              releaseId: opportunity.releaseId,
            };
          }),
      )
      .sort(
        (a, b) =>
          b.expectedProfit - a.expectedProfit ||
          a.opportunityId.localeCompare(b.opportunityId) ||
          a.taskId.localeCompare(b.taskId),
      );
  }

  assertConservation(opportunityId) {
    const opportunity = this.#opportunity(opportunityId);
    if (opportunity.kind === "EXTERNAL") {
      invariant(
        opportunity.maxBudget ===
          opportunity.spent + opportunity.refunded + opportunity.escrowed,
        "EXTERNAL_CONSERVATION_FAILED",
      );
      invariant(opportunity.minted === 0, "EXTERNAL_JOB_MINTED");
    } else {
      invariant(
        opportunity.spent >= opportunity.minted,
        "SYSTEM_MINT_EXCEEDS_SETTLEMENT",
      );
      invariant(opportunity.spent <= opportunity.maxBudget, "SYSTEM_CAP_EXCEEDED");
    }
    return true;
  }

  agent(id) {
    return structuredClone(this.#agent(id));
  }

  opportunity(id) {
    const opportunity = this.#opportunity(id);
    return {
      ...structuredClone({
        ...opportunity,
        tasks: undefined,
        pendingPayouts: undefined,
        settledPayouts: undefined,
        quotePayouts: undefined,
        canaryAttestations: undefined,
      }),
      tasks: [...opportunity.tasks.values()].map((task) => ({
        ...structuredClone({
          ...task,
          bids: undefined,
        }),
        bids: Object.fromEntries(task.bids),
      })),
      settledPayouts: Object.fromEntries(opportunity.settledPayouts),
      quotePayouts: Object.fromEntries(opportunity.quotePayouts),
      canaryAttestations: Object.fromEntries(opportunity.canaryAttestations),
    };
  }

  release(id) {
    const release = this.releases.get(id);
    invariant(release, "UNKNOWN_RELEASE");
    return structuredClone(release);
  }

  proposal(id) {
    const proposal = this.#proposal(id);
    return {
      ...structuredClone({
        ...proposal,
        votes: undefined,
        groups: undefined,
        adoptions: undefined,
        adoptionGroups: undefined,
        snapshotWeights: undefined,
      }),
      votes: Object.fromEntries(proposal.votes),
      groups: [...proposal.groups],
      adoptions: Object.fromEntries(proposal.adoptions),
      adoptionGroups: [...proposal.adoptionGroups],
      snapshotWeights: Object.fromEntries(proposal.snapshotWeights),
    };
  }

  snapshot() {
    return {
      financeInvariantHash: this.financeInvariantHash,
      recommendedRelease: this.recommendedRelease,
      agents: Object.fromEntries(
        [...this.agents].map(([id]) => [id, this.agent(id)]),
      ),
      opportunities: Object.fromEntries(
        [...this.opportunities].map(([id]) => [id, this.opportunity(id)]),
      ),
      releases: Object.fromEntries(
        [...this.releases].map(([id, release]) => [id, structuredClone(release)]),
      ),
      proposals: Object.fromEntries(
        [...this.proposals].map(([id]) => [id, this.proposal(id)]),
      ),
      balances: Object.fromEntries(this.balances),
      slashPool: this.slashPool,
    };
  }

  #rankBids(bids, track) {
    return bids
      .map((bid) => {
        const profile = this.#agent(bid.agentId).profiles[track];
        const success = verifiedSuccessBps(profile);
        const failureLoss = Math.floor(
          ((BPS - success) * bid.bond) / BPS,
        );
        return {
          ...bid,
          riskAdjustedCost:
            Math.ceil((bid.price * BPS) / success) +
            Math.ceil(bid.durationMs / 1_000) +
            failureLoss,
        };
      })
      .sort(
        (a, b) =>
          a.riskAdjustedCost - b.riskAdjustedCost ||
          a.price - b.price ||
          a.agentId.localeCompare(b.agentId),
      );
  }

  #selectedPlan(opportunity) {
    const plan = opportunity.plans.find((entry) => entry.id === opportunity.selectedPlanId);
    invariant(plan, "NO_SELECTED_PLAN");
    return plan;
  }

  #agent(id) {
    const agent = this.agents.get(id);
    invariant(agent, "UNKNOWN_AGENT");
    return agent;
  }

  #opportunity(id) {
    const opportunity = this.opportunities.get(id);
    invariant(opportunity, "UNKNOWN_OPPORTUNITY");
    return opportunity;
  }

  #task(opportunity, id) {
    const task = opportunity.tasks.get(id);
    invariant(task, "UNKNOWN_TASK");
    return task;
  }

  #proposal(id) {
    const proposal = this.proposals.get(id);
    invariant(proposal, "UNKNOWN_EVOLUTION_PROPOSAL");
    return proposal;
  }
}

export { digest };
