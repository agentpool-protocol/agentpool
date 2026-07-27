import { digest } from "./agentpool-v43-engine.mjs";

/// @notice Deterministic reference policy used to prove that separate agents
///         can traverse the entire market without an operator assigning roles.
///         Real Codex, Claude, Qwen, or local-model adapters replace only the
///         `policy` methods; the market and finance rules stay unchanged.
export class AgentPoolV43ReferenceSwarm {
  constructor(engine, policies) {
    this.engine = engine;
    this.policies = new Map(policies.map((policy) => [policy.agentId, policy]));
  }

  async runOpportunity(opportunityId) {
    let opportunity = this.engine.opportunity(opportunityId);
    if (opportunity.state === "PLANNING") {
      for (const policy of this.policies.values()) {
        if (policy.roles.includes("PRICER")) {
          const quote = await policy.quote(opportunity);
          this.engine.submitRewardQuote(opportunityId, {
            agentId: policy.agentId,
            ...quote,
          });
        }
      }
      for (const policy of this.policies.values()) {
        if (!policy.roles.includes("PLANNER")) continue;
        const plan = await policy.plan(opportunity);
        this.engine.submitPlan(opportunityId, {
          plannerId: policy.agentId,
          ...plan,
        });
      }
      this.engine.awardPlan(opportunityId);
    }

    opportunity = this.engine.opportunity(opportunityId);
    for (const task of opportunity.tasks) {
      if (task.state !== "OPEN") continue;
      for (const policy of this.policies.values()) {
        if (policy.roles.includes("WORKER") && policy.capabilities.includes(task.capability)) {
          const bid = await policy.bid(opportunity, task, "WORKER");
          this.engine.submitRoleBid(opportunityId, task.id, {
            agentId: policy.agentId,
            role: "WORKER",
            ...bid,
          });
        }
        if (policy.roles.includes("VALIDATOR")) {
          const bid = await policy.bid(opportunity, task, "VALIDATOR");
          this.engine.submitRoleBid(opportunityId, task.id, {
            agentId: policy.agentId,
            role: "VALIDATOR",
            ...bid,
          });
        }
      }
    }

    while (this.engine.allocateReadyTasks(opportunityId) > 0) {
      opportunity = this.engine.opportunity(opportunityId);
      for (const task of opportunity.tasks) {
        if (task.state !== "AWARDED") continue;
        const workerPolicy = this.policies.get(task.allocation.worker.agentId);
        const delivery = await workerPolicy.execute(opportunity, task);
        this.engine.deliverTask(opportunityId, task.id, {
          agentId: workerPolicy.agentId,
          ...delivery,
        });
        for (const allocation of task.allocation.validators) {
          const validatorPolicy = this.policies.get(allocation.agentId);
          const evaluation = await validatorPolicy.evaluate(
            opportunity,
            task,
            delivery,
          );
          this.engine.evaluateTask(opportunityId, task.id, {
            agentId: validatorPolicy.agentId,
            ...evaluation,
          });
        }
        const result = this.engine.settleTask(opportunityId, task.id);
        if (!result.passed) return { state: "REPLAN_REQUIRED", taskId: task.id };
      }
    }

    opportunity = this.engine.opportunity(opportunityId);
    if (opportunity.tasks.every((task) => task.state === "SETTLED")) {
      return this.engine.finalizeOpportunity(opportunityId);
    }
    return {
      state: opportunity.state,
      waitingTasks: opportunity.tasks
        .filter((task) => task.state !== "SETTLED")
        .map((task) => task.id),
    };
  }
}

export function createReferencePolicy({
  agentId,
  roles,
  capabilities = [],
  price = 50,
  qualityBps = 9_000,
}) {
  return {
    agentId,
    roles,
    capabilities,
    async quote(opportunity) {
      return {
        amount: Math.floor(opportunity.maxBudget * 0.9),
        riskBps: 500,
        feeAsk: 10,
        evidenceHash: digest({
          agentId,
          opportunityId: opportunity.id,
          quote: opportunity.maxBudget,
        }),
      };
    },
    async plan(opportunity) {
      const pricingBudget = 30;
      const plannerFee = 100;
      const contingency = 170;
      const taskBudget =
        opportunity.maxBudget - pricingBudget - plannerFee - contingency;
      const tasks = [
        {
          id: `${opportunity.id}-implementation`,
          dependencies: [],
          capability: capabilities[0] ?? "code",
          maxBudget: taskBudget,
          minValidators: 3,
          minScoreBps: opportunity.minScoreBps,
          deadline: opportunity.deadline - 1,
        },
      ];
      return {
        id: `${opportunity.id}-${agentId}-plan`,
        tasks,
        plannerFee,
        pricingBudget,
        contingency,
        totalBid: opportunity.maxBudget,
        bond: 100,
        planHash: digest({ tasks, plannerFee, pricingBudget, contingency }),
      };
    },
    async bid(opportunity, task, role) {
      return {
        price: role === "WORKER" ? price : Math.min(price, 50),
        durationMs: role === "WORKER" ? 500 : 250,
        bond: role === "WORKER" ? 100 : 50,
        nonce: digest({ agentId, opportunityId: opportunity.id, taskId: task.id, role }),
      };
    },
    async execute(opportunity, task) {
      return {
        artifactHash: digest({
          releaseId: opportunity.releaseId,
          taskId: task.id,
          producedBy: agentId,
        }),
        evidenceHash: digest({
          taskId: task.id,
          runtime: agentId,
          deterministicReplay: true,
        }),
        actualUsage: 1,
      };
    },
    async evaluate(opportunity, task, delivery) {
      return {
        scoreBps: qualityBps,
        objectivePassed: true,
        evidenceHash: digest({
          opportunityId: opportunity.id,
          taskId: task.id,
          validator: agentId,
          artifactHash: delivery.artifactHash,
        }),
      };
    },
  };
}
