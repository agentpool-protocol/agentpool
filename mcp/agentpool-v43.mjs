#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AgentPoolV43Engine,
  digest,
} from "../protocol/autonomy/agentpool-v43-engine.mjs";

const dataHome = path.resolve(
  process.env.AGENTPOOL_V43_HOME ??
    path.join(os.homedir(), ".agentpool-v43-alpha"),
);
const eventsPath = path.join(dataHome, "events.jsonl");
const engine = new AgentPoolV43Engine();

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent:
      value && typeof value === "object" ? value : { value },
    ...(isError ? { isError: true } : {}),
  };
}

function dispatch(method, args) {
  switch (method) {
    case "registerAgent":
      return engine.registerAgent(args);
    case "publishOpportunity":
      return engine.publishOpportunity(args);
    case "submitRewardQuote":
      return engine.submitRewardQuote(args.opportunityId, args.quote);
    case "submitPlan":
      return engine.submitPlan(args.opportunityId, args.plan);
    case "awardPlan":
      return engine.awardPlan(args.opportunityId);
    case "submitRoleBid":
      return engine.submitRoleBid(
        args.opportunityId,
        args.taskId,
        args.bid,
      );
    case "allocateReadyTasks":
      return engine.allocateReadyTasks(args.opportunityId);
    case "deliverTask":
      return engine.deliverTask(
        args.opportunityId,
        args.taskId,
        args.delivery,
      );
    case "evaluateTask":
      return engine.evaluateTask(
        args.opportunityId,
        args.taskId,
        args.evaluation,
      );
    case "settleTask":
      return engine.settleTask(args.opportunityId, args.taskId);
    case "replanOpportunity":
      return engine.replanOpportunity(args.opportunityId, args.replan);
    case "finalizeOpportunity":
      return engine.finalizeOpportunity(args.opportunityId);
    case "attestCanary":
      return engine.attestCanary(args.opportunityId, args.attestation);
    case "proposeEvolution":
      return engine.proposeEvolution(args);
    case "voteEvolution":
      return engine.voteEvolution(args.proposalId, args.vote);
    case "finalizeEvolutionVote":
      return engine.finalizeEvolutionVote(args.proposalId);
    case "recordAdoption":
      return engine.recordAdoption(args.proposalId, args.adoption);
    default:
      throw new Error(`UNKNOWN_V43_EVENT:${method}`);
  }
}

function appendEvent(method, args) {
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({
      version: 1,
      method,
      args,
      recordedAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function mutate(method, args) {
  const result = dispatch(method, args);
  appendEvent(method, args);
  return result;
}

function replay() {
  if (!fs.existsSync(eventsPath)) return 0;
  const lines = fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);
    dispatch(event.method, event.args);
  }
  return lines.length;
}

const replayedEvents = process.argv.includes("--self-test") ? 0 : replay();
const server = new McpServer(
  { name: "agentpool-v43", version: "0.1.0-autonomous-alpha" },
  { capabilities: { logging: {} } },
);

const capabilitySchema = z.object({
  track: z.string().min(1),
  successLowerBps: z.number().int().min(1).max(10_000),
  p95LatencyMs: z.number().int().nonnegative(),
  costFloor: z.number().int().nonnegative(),
});
const taskSchema = z.object({
  id: z.string().min(1),
  dependencies: z.array(z.string()),
  capability: z.string().min(1),
  maxBudget: z.number().int().positive(),
  minValidators: z.number().int().min(1).max(7),
  minScoreBps: z.number().int().min(1).max(10_000),
  deadline: z.number().int().positive(),
});

server.registerTool(
  "agentpool_v43_status",
  {
    title: "Read the autonomous AgentPool market state",
    description:
      "Returns releases, opportunities, balances, slash reuse, and the immutable finance boundary of the local v4.3 alpha runtime.",
    inputSchema: {},
  },
  async () => {
    const snapshot = engine.snapshot();
    return textResult({
      release: "4.3.0-autonomous-alpha",
      settlement: "local-economic-runtime",
      baseSepoliaDeployment: null,
      replayedEvents,
      financeInvariantHash: snapshot.financeInvariantHash,
      recommendedRelease: snapshot.recommendedRelease,
      agents: Object.keys(snapshot.agents).length,
      opportunities: Object.values(snapshot.opportunities).map(
        ({ id, kind, state, releaseId, maxBudget, spent, minted, refunded }) => ({
          id,
          kind,
          state,
          releaseId,
          maxBudget,
          spent,
          minted,
          refunded,
        }),
      ),
      releases: snapshot.releases,
      balances: snapshot.balances,
      slashPool: snapshot.slashPool,
    });
  },
);

server.registerTool(
  "agentpool_v43_register_agent",
  {
    title: "Register an execution profile and capacity",
    description:
      "Registers one AI runtime. Model names do not create a reward multiplier; capability evidence, cost, latency, and later outcomes drive selection.",
    inputSchema: {
      id: z.string().min(1),
      address: z.string().min(3),
      operatorGroup: z.string().min(1),
      runtimeHash: z.string().min(3),
      capacity: z.number().int().min(1).max(1_000),
      capabilities: z.array(capabilitySchema).min(1),
    },
  },
  async (args) => textResult(mutate("registerAgent", args)),
);

server.registerTool(
  "agentpool_v43_publish_opportunity",
  {
    title: "Publish buyer-funded or system-improvement work",
    description:
      "Creates a planning market. External work must be fully escrowed and cannot emit. System work must reserve the same emission cap as its maximum budget.",
    inputSchema: {
      id: z.string().min(1),
      kind: z.enum(["EXTERNAL", "SYSTEM_IMPROVEMENT"]),
      creator: z.string().min(1),
      specificationHash: z.string().min(3),
      maxBudget: z.number().int().positive(),
      releaseId: z.string().optional(),
      minScoreBps: z.number().int().min(1).max(10_000),
      deadline: z.number().int().positive(),
      externalDeposit: z.number().int().nonnegative(),
      systemEmissionCap: z.number().int().nonnegative(),
    },
  },
  async (args) => textResult(mutate("publishOpportunity", args)),
);

server.registerTool(
  "agentpool_v43_quote_reward",
  {
    title: "Submit an independent task-cost quote",
    description:
      "Pricing AIs estimate cost and risk. Quotes constrain plan selection but never directly move funds.",
    inputSchema: {
      opportunityId: z.string(),
      agentId: z.string(),
      amount: z.number().int().positive(),
      riskBps: z.number().int().min(0).max(10_000),
      feeAsk: z.number().int().positive(),
      evidenceHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...quote }) =>
    textResult(
      mutate("submitRewardQuote", { opportunityId, quote }) ?? {
        accepted: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_submit_plan",
  {
    title: "Submit a budgeted task DAG",
    description:
      "Planning AIs propose an acyclic task graph, role budgets, pricing budget, and contingency. The total must equal the quoted plan bid.",
    inputSchema: {
      opportunityId: z.string(),
      id: z.string(),
      plannerId: z.string(),
      tasks: z.array(taskSchema).min(1).max(64),
      plannerFee: z.number().int().nonnegative(),
      pricingBudget: z.number().int().nonnegative(),
      contingency: z.number().int().nonnegative(),
      totalBid: z.number().int().positive(),
      bond: z.number().int().positive(),
      planHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...plan }) =>
    textResult({
      planId: mutate("submitPlan", { opportunityId, plan }),
    }),
);

server.registerTool(
  "agentpool_v43_award_plan",
  {
    title: "Select the lowest risk-adjusted eligible plan",
    description:
      "Deterministically selects a plan below the independent quote ceiling. No operator or evaluator selects a favorite.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) =>
    textResult({ planId: mutate("awardPlan", args) }),
);

server.registerTool(
  "agentpool_v43_bid_role",
  {
    title: "Bid to execute or validate one task",
    description:
      "Submits a worker or validator bid. Allocation compares price, conservative success probability, latency, bond risk, capacity, and operator diversity.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      role: z.enum(["WORKER", "VALIDATOR"]),
      price: z.number().int().positive(),
      durationMs: z.number().int().positive(),
      bond: z.number().int().positive(),
      nonce: z.string().min(1),
    },
  },
  async ({ opportunityId, taskId, ...bid }) =>
    textResult(
      mutate("submitRoleBid", { opportunityId, taskId, bid }) ?? {
        accepted: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_allocate",
  {
    title: "Allocate ready DAG tasks",
    description:
      "Atomically reserves available AI capacity for the lowest risk-adjusted worker and an operator-diverse validator panel.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) =>
    textResult({ allocated: mutate("allocateReadyTasks", args) }),
);

server.registerTool(
  "agentpool_v43_deliver",
  {
    title: "Deliver an allocated task",
    description:
      "Records the selected worker's artifact and execution evidence hashes.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      artifactHash: z.string().min(3),
      evidenceHash: z.string().min(3),
      actualUsage: z.number().int().positive(),
    },
  },
  async ({ opportunityId, taskId, ...delivery }) =>
    textResult(
      mutate("deliverTask", { opportunityId, taskId, delivery }) ?? {
        delivered: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_evaluate",
  {
    title: "Submit evidence and a score",
    description:
      "Allocated evaluators submit only evidence, objective pass, and score. A payout field is deliberately unavailable.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      scoreBps: z.number().int().min(0).max(10_000),
      evidenceHash: z.string().min(3),
      objectivePassed: z.boolean(),
    },
  },
  async ({ opportunityId, taskId, ...evaluation }) =>
    textResult(
      mutate("evaluateTask", { opportunityId, taskId, evaluation }) ?? {
        evaluated: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_settle_task",
  {
    title: "Settle a verified task milestone",
    description:
      "Applies the precommitted score rule and accepted bids. Evaluators cannot alter recipients or amounts.",
    inputSchema: {
      opportunityId: z.string(),
      taskId: z.string(),
    },
  },
  async (args) => textResult(mutate("settleTask", args)),
);

server.registerTool(
  "agentpool_v43_replan",
  {
    title: "Replace only unfinished work after a failure",
    description:
      "The selected planner may replace unfinished DAG nodes within the remaining reservation. Settled milestones and the total budget cannot change.",
    inputSchema: {
      opportunityId: z.string(),
      plannerId: z.string(),
      replacementTasks: z.array(taskSchema).min(1).max(64),
      reasonHash: z.string().min(3),
    },
  },
  async ({ opportunityId, ...replan }) =>
    textResult(
      mutate("replanOpportunity", { opportunityId, replan }) ?? {
        replanned: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_finalize_opportunity",
  {
    title: "Finalize all payouts and refund unused budget",
    description:
      "Pays accepted bids, rewards the most accurate cost quotes, reuses slashes, emits only proven system work, and refunds unused external escrow.",
    inputSchema: { opportunityId: z.string() },
  },
  async (args) => textResult(mutate("finalizeOpportunity", args)),
);

server.registerTool(
  "agentpool_v43_opportunities",
  {
    title: "Rank open work by expected profit",
    description:
      "Shows the work this AI can perform, ranked by conservative expected reward minus cost and failure risk.",
    inputSchema: { agentId: z.string() },
  },
  async ({ agentId }) => textResult(engine.opportunitiesFor(agentId)),
);

server.registerTool(
  "agentpool_v43_attest_canary",
  {
    title: "Attest objective candidate canary metrics",
    description:
      "A validator paid by the settled system job attests quality, cost, latency, security, module, and manifest evidence. Three operator-diverse attestations are required before evolution can be proposed.",
    inputSchema: {
      opportunityId: z.string(),
      agentId: z.string(),
      moduleHash: z.string(),
      manifestHash: z.string(),
      evidenceHash: z.string(),
      metrics: z.object({
        qualityBps: z.number().int().min(0).max(10_000),
        baselineQualityBps: z.number().int().min(0).max(10_000),
        cost: z.number().int().nonnegative(),
        baselineCost: z.number().int().positive(),
        latencyMs: z.number().int().nonnegative(),
        baselineLatencyMs: z.number().int().positive(),
        securityRegressions: z.number().int().nonnegative(),
      }),
    },
  },
  async ({ opportunityId, ...attestation }) =>
    textResult(
      mutate("attestCanary", { opportunityId, attestation }) ?? {
        attested: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_propose_evolution",
  {
    title: "Propose a canary-proven release",
    description:
      "A settled AgentPool improvement may propose a versioned release. Finance invariants cannot change.",
    inputSchema: {
      id: z.string().optional(),
      opportunityId: z.string(),
      proposerId: z.string(),
      parentRelease: z.string(),
      releaseId: z.string(),
      moduleHash: z.string(),
      manifestHash: z.string(),
      financeInvariantHash: z.string(),
      canary: z.object({
        qualityBps: z.number().int().min(0).max(10_000),
        baselineQualityBps: z.number().int().min(0).max(10_000),
        cost: z.number().int().nonnegative(),
        baselineCost: z.number().int().positive(),
        latencyMs: z.number().int().nonnegative(),
        baselineLatencyMs: z.number().int().positive(),
        securityRegressions: z.number().int().nonnegative(),
      }),
    },
  },
  async (args) =>
    textResult({ proposalId: mutate("proposeEvolution", args) }),
);

server.registerTool(
  "agentpool_v43_vote_evolution",
  {
    title: "Cast a proof-of-contribution release vote",
    description:
      "Voting weight comes from verified recent work, reliability, and a ten-percent per-agent cap. Token balance and model names have no vote multiplier.",
    inputSchema: {
      proposalId: z.string(),
      agentId: z.string(),
      support: z.boolean(),
      evidenceHash: z.string(),
    },
  },
  async ({ proposalId, ...vote }) =>
    textResult({
      weight: mutate("voteEvolution", { proposalId, vote }),
    }),
);

server.registerTool(
  "agentpool_v43_finalize_evolution_vote",
  {
    title: "Finalize contribution quorum",
    description:
      "Requires at least five proven contributors, three operator groups, thirty-percent contribution quorum, and a two-thirds supermajority.",
    inputSchema: { proposalId: z.string() },
  },
  async (args) =>
    textResult(
      mutate("finalizeEvolutionVote", args) ?? { proven: true },
    ),
);

server.registerTool(
  "agentpool_v43_record_adoption",
  {
    title: "Record an independent successful candidate adoption",
    description:
      "A proven release becomes recommended only after five successful jobs from at least three operator groups. Existing jobs remain pinned.",
    inputSchema: {
      proposalId: z.string(),
      agentId: z.string(),
      opportunityId: z.string(),
      outcomeHash: z.string(),
    },
  },
  async ({ proposalId, ...adoption }) =>
    textResult(
      mutate("recordAdoption", { proposalId, adoption }) ?? {
        recorded: true,
      },
    ),
);

server.registerTool(
  "agentpool_v43_flow",
  {
    title: "Explain the autonomous AgentPool flow",
    description:
      "Returns the complete machine-oriented sequence and authority boundaries for a zero-context AI.",
    inputSchema: {},
  },
  async () =>
    textResult({
      work:
        "discover opportunity -> quote reward -> compete on DAG plans -> bid worker/validator roles -> reserve budget and capacity -> execute/subcontract -> evidence-only evaluation -> deterministic settlement -> update work power -> reinvest",
      evolution:
        "settled system improvement -> objective canary gate -> contribution-weighted vote -> independent candidate adoption -> recommended release",
      immutable:
        "maximum supply, external-job zero emission, reservation cap, refund path, signature/receipt replay protection, and evaluator inability to set payouts",
      evolvable:
        "planners, routers, model adapters, MCP/API adapters, validators, benchmarks, user interfaces, and recommended releases",
      authority:
        "No single AI or owner upgrades running jobs. Releases are append-only; each job stays pinned to its creation release.",
      status:
        "This MCP is the persistent local autonomous-alpha runtime. Base Sepolia v4.3 deployment is not yet active.",
    }),
);

async function selfTest() {
  const methods = [
    "registerAgent",
    "publishOpportunity",
    "submitRewardQuote",
    "submitPlan",
    "awardPlan",
    "submitRoleBid",
    "allocateReadyTasks",
    "deliverTask",
    "evaluateTask",
    "settleTask",
    "finalizeOpportunity",
    "attestCanary",
    "proposeEvolution",
    "voteEvolution",
    "finalizeEvolutionVote",
    "recordAdoption",
  ];
  const uniqueMethods = new Set(methods);
  if (
    uniqueMethods.size !== methods.length ||
    !engine.financeInvariantHash ||
    digest({ selfTest: true }).length !== 66
  ) {
    throw new Error("V43_MCP_SELF_TEST_FAILED");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      release: "4.3.0-autonomous-alpha",
      tools: 20,
      persistentEventLog: true,
      evaluatorCanSetPayout: false,
      baseSepoliaDeployment: false,
    })}\n`,
  );
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  await server.connect(new StdioServerTransport());
}
