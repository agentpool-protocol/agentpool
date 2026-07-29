import { randomBytes } from "node:crypto";
import { keccak256, parseUnits, toBytes } from "viem";
import {
  AUTONOMY_EVENT_TYPES,
  autonomyDigest,
  buildTaskDag,
  createRiskAdjustedBid,
  detectImprovementIssues,
  evaluateCanary,
  rankWorkChoicesByExpectedNetProfit,
  selectWinningBids,
  validateExecutionResult,
} from "./agentpool-autonomy-core.mjs";
import {
  openPrivateJson,
  sealPrivateJson,
} from "./private-channel.mjs";
import {
  RUNNER_EVENT_TYPES,
  unwrapCoordinationEvent,
} from "./agentpool-runner-core.mjs";

function roleEnabled(config, role) {
  return (config.roles ?? ["WORKER"]).includes(role);
}

function autonomyState(state) {
  state.autonomy ??= {
    cursor: 0,
    processed: {},
    validations: {},
  };
  return state.autonomy;
}

async function publish(mcp, eventType, event, payload, now) {
  return mcp.call("agentpool_v43_publish_coordination", {
    eventType,
    opportunityId: event.opportunityId,
    parentEventId: event.id,
    payloadJson: JSON.stringify(payload),
    expiresAt: Math.min(
      Number(payload.expiresAt ?? now + 7 * 24 * 60 * 60 * 1_000),
      now + 30 * 24 * 60 * 60 * 1_000,
    ),
  });
}

function planEvents(events, opportunityId) {
  return events.filter(
    (event) =>
      event.opportunityId === opportunityId &&
      event.eventType === AUTONOMY_EVENT_TYPES.plan,
  );
}

function bidEvents(events, opportunityId) {
  return events.filter(
    (event) =>
      event.opportunityId === opportunityId &&
      event.eventType === AUTONOMY_EVENT_TYPES.bid,
  );
}

function choosePlan(plans) {
  return plans
    .map((event) => unwrapCoordinationEvent(event))
    .sort((left, right) => {
      const budget =
        BigInt(left.maxBudgetBaseUnits) -
        BigInt(right.maxBudgetBaseUnits);
      if (budget !== 0n) return budget < 0n ? -1 : 1;
      return String(left.planHash).localeCompare(String(right.planHash));
    })[0];
}

function validAuditText(value, minimum, maximum) {
  return (
    typeof value === "string" &&
    value.trim().length >= minimum &&
    value.trim().length <= maximum
  );
}

function validRepositoryPath(value) {
  if (!validAuditText(value, 3, 240)) return false;
  const normalized = value.replaceAll("\\", "/").trim();
  return (
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    normalized.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

export function validateIdleImprovementAudit(audit) {
  const content = String(audit?.content ?? "").trim();
  if (content === "NO_ACTIONABLE_ISSUE") {
    return { status: "no-actionable-issue" };
  }
  let issue;
  try {
    issue = JSON.parse(content);
  } catch {
    return {
      status: "invalid-audit-evidence",
      reason: "AUDIT_CONTENT_MUST_BE_JSON",
    };
  }
  if (
    !issue ||
    typeof issue !== "object" ||
    Array.isArray(issue) ||
    issue.status !== "ISSUE" ||
    !validAuditText(issue.title, 10, 200) ||
    !validAuditText(issue.impact, 20, 2_000) ||
    !validAuditText(issue.proposedFix, 20, 4_000) ||
    !validAuditText(issue.acceptanceTest, 20, 4_000) ||
    !Array.isArray(issue.affectedFiles) ||
    issue.affectedFiles.length === 0 ||
    issue.affectedFiles.length > 20 ||
    !issue.affectedFiles.every(validRepositoryPath) ||
    !Array.isArray(issue.reproductionSteps) ||
    issue.reproductionSteps.length === 0 ||
    issue.reproductionSteps.length > 20 ||
    !issue.reproductionSteps.every((step) =>
      validAuditText(step, 15, 2_000),
    ) ||
    !validAuditText(audit?.evidence?.summary, 10, 1_000) ||
    !validAuditText(audit?.evidence?.digest, 8, 200) ||
    !/^[A-Za-z0-9._:-]+$/.test(audit.evidence.digest)
  ) {
    return {
      status: "invalid-audit-evidence",
      reason: "AUDIT_REQUIRED_FIELDS_INVALID",
    };
  }
  const canonicalIssue = {
    status: "ISSUE",
    title: issue.title.trim(),
    affectedFiles: issue.affectedFiles.map((file) =>
      file.replaceAll("\\", "/").trim(),
    ),
    reproductionSteps: issue.reproductionSteps.map((step) => step.trim()),
    impact: issue.impact.trim(),
    proposedFix: issue.proposedFix.trim(),
    acceptanceTest: issue.acceptanceTest.trim(),
  };
  return {
    status: "issue",
    issue: canonicalIssue,
    canonicalContent: JSON.stringify(canonicalIssue),
  };
}

export function validateImprovementCandidateExecution(execution) {
  const evidence = execution?.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !Array.isArray(evidence.changedFiles) ||
    evidence.changedFiles.length === 0 ||
    evidence.changedFiles.length > 40 ||
    !evidence.changedFiles.every(validRepositoryPath) ||
    evidence.testPassed !== true ||
    !validAuditText(evidence.testCommand, 3, 1_000) ||
    !validAuditText(evidence.patchDigest, 8, 200) ||
    !/^[A-Za-z0-9._:-]+$/.test(evidence.patchDigest) ||
    !validAuditText(execution?.content, 20, 20_000)
  ) {
    return {
      valid: false,
      reason: "CANDIDATE_CHANGE_AND_TEST_EVIDENCE_REQUIRED",
    };
  }
  return {
    valid: true,
    evidence: {
      summary: evidence.summary,
      digest: evidence.digest,
      changedFiles: evidence.changedFiles.map((file) =>
        file.replaceAll("\\", "/").trim(),
      ),
      testCommand: evidence.testCommand.trim(),
      testPassed: true,
      patchDigest: evidence.patchDigest.trim(),
    },
  };
}

export async function executeRunnerTaskWithAdapters(
  task,
  { config, executorRegistry },
) {
  let decoded = task;
  if (task.kind === "PRIVATE_ENVELOPE") {
    if (!config.privateChannelPrivateKey) {
      throw new Error("RUNNER_PRIVATE_CHANNEL_KEY_REQUIRED");
    }
    decoded = await openPrivateJson(
      config.privateChannelPrivateKey,
      task.envelope,
    );
  }
  if (decoded.kind !== "AGENT_EXECUTE") {
    return null;
  }
  const execution = await executorRegistry.execute(decoded);
  return execution.content;
}

export async function runAutonomyRoleCycle({
  config,
  mcp,
  state,
  wallet,
  executorRegistry,
  now = Date.now(),
}) {
  const local = autonomyState(state);
  const relay = await mcp.call("agentpool_v43_shared_coordination", {
    since: local.cursor,
    limit: 200,
  });
  const events = relay.events ?? [];
  const outcomes = [];
  const selectedBidCandidates = new Map();

  if (roleEnabled(config, "BIDDER")) {
    const profiles = config.bidProfiles ?? [];
    const minimumNetProfit = parseUnits(
      String(config.minNetProfitApool ?? "0"),
      18,
    );
    const candidates = [];
    for (const event of events.filter(
      (candidate) =>
        candidate.eventType === AUTONOMY_EVENT_TYPES.plan,
    )) {
      const payload = unwrapCoordinationEvent(event);
      for (const task of payload.tasks ?? []) {
        for (const profile of profiles.filter(
          (candidate) =>
            candidate.capability === task.capability &&
            candidate.enabled !== false,
        )) {
          try {
            const bid = createRiskAdjustedBid(task, {
              ...profile,
              bidderAddress: wallet.address,
              operatorGroup: config.operatorGroup,
              expiresAt: Math.min(
                Number(profile.expiresAt ?? now + 10 * 60 * 1_000),
                Number(event.expiresAt),
              ),
            });
            if (
              BigInt(bid.expectedNetProfitBaseUnits) <
              minimumNetProfit
            ) {
              continue;
            }
            candidates.push({
              key: `${event.id}:${task.id}:${profile.provider}`,
              event,
              payload,
              task,
              bid,
            });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes(
                "AUTONOMY_BID_EXCEEDS_TASK_BUDGET",
              )
            ) {
              throw error;
            }
          }
        }
      }
    }
    const defaultCapacity = Math.max(
      1,
      ...profiles.map((profile) =>
        Math.max(1, Number(profile.capacityUnits ?? 1)),
      ),
    );
    const capacity = Math.max(
      0,
      Number(config.maximumConcurrentBids ?? defaultCapacity),
    );
    candidates
      .sort((left, right) => {
        const profit =
          BigInt(right.bid.expectedNetProfitBaseUnits) -
          BigInt(left.bid.expectedNetProfitBaseUnits);
        if (profit !== 0n) return profit > 0n ? 1 : -1;
        return left.key.localeCompare(right.key);
      })
      .slice(0, capacity)
      .forEach((candidate) =>
        selectedBidCandidates.set(candidate.key, candidate),
      );
  }

  for (const event of events) {
    const key = `${event.id}:${(config.roles ?? ["WORKER"]).join(",")}`;
    if (local.processed[key]) {
      local.cursor = Math.max(local.cursor, Number(event.createdAt) + 1);
      continue;
    }
    const payload = unwrapCoordinationEvent(event);
    try {
      if (
        event.eventType === AUTONOMY_EVENT_TYPES.opportunity &&
        roleEnabled(config, "PLANNER")
      ) {
        const plan = buildTaskDag(payload);
        const published = await publish(
          mcp,
          AUTONOMY_EVENT_TYPES.plan,
          event,
          {
            ...plan,
            plannerAddress: wallet.address,
            operatorGroup: config.operatorGroup,
            expiresAt: payload.expiresAt,
          },
          now,
        );
        outcomes.push({
          role: "PLANNER",
          status: "planned",
          opportunityId: event.opportunityId,
          eventId: published.id,
        });
      }

      if (
        event.eventType === AUTONOMY_EVENT_TYPES.plan &&
        roleEnabled(config, "BIDDER")
      ) {
        for (const candidate of selectedBidCandidates.values()) {
          if (candidate.event.id !== event.id) continue;
          const { task, bid } = candidate;
            const published = await publish(
              mcp,
              AUTONOMY_EVENT_TYPES.bid,
              event,
              { ...bid, planId: payload.planId, planHash: payload.planHash },
              now,
            );
            outcomes.push({
              role: "BIDDER",
              status: "bid",
              taskId: task.id,
              market: task.market,
              expectedNetProfitBaseUnits:
                bid.expectedNetProfitBaseUnits,
              expectedNetProfitApool: bid.expectedNetProfitApool,
              eventId: published.id,
            });
        }
      }

      if (
        [
          AUTONOMY_EVENT_TYPES.opportunity,
          AUTONOMY_EVENT_TYPES.plan,
          AUTONOMY_EVENT_TYPES.bid,
        ].includes(event.eventType) &&
        roleEnabled(config, "COORDINATOR")
      ) {
        const all = await mcp.call("agentpool_v43_shared_coordination", {
          opportunityId: event.opportunityId,
          since: 0,
          limit: 200,
        });
        if (
          (all.events ?? []).some(
            (candidate) =>
              candidate.eventType ===
              AUTONOMY_EVENT_TYPES.award,
          )
        ) {
          local.processed[key] = now;
          local.cursor = Math.max(
            local.cursor,
            Number(event.createdAt) + 1,
          );
          continue;
        }
        const plan = choosePlan(
          planEvents(all.events ?? [], event.opportunityId),
        );
        if (plan) {
          const bids = bidEvents(
            all.events ?? [],
            event.opportunityId,
          ).map((candidate) => unwrapCoordinationEvent(candidate));
          if (bids.length >= plan.tasks.length) {
            const award = selectWinningBids(plan, bids);
            const originalOpportunity = (all.events ?? []).find(
              (candidate) =>
                candidate.eventType ===
                AUTONOMY_EVENT_TYPES.opportunity,
            );
            const published = await publish(
              mcp,
              AUTONOMY_EVENT_TYPES.award,
              originalOpportunity ?? event,
              {
                ...award,
                coordinatorAddress: wallet.address,
                funding:
                  "BUYER_SIGNATURE_REQUIRED_BEFORE_ONCHAIN_EXECUTION",
                expiresAt:
                  unwrapCoordinationEvent(
                    originalOpportunity ?? event,
                  ).expiresAt ?? event.expiresAt,
              },
              now,
            );
            outcomes.push({
              role: "COORDINATOR",
              status: "awarded",
              eventId: published.id,
              selected: award.selected.length,
            });
          }
        }
      }

      if (
        event.eventType === AUTONOMY_EVENT_TYPES.gasRequest &&
        roleEnabled(config, "GAS_SPONSOR")
      ) {
        const requestedWei = BigInt(
          config.gasSponsor?.grantWei ?? "0",
        );
        const maximumWei = BigInt(
          config.gasSponsor?.maximumGrantWei ?? "0",
        );
        if (
          requestedWei > 0n &&
          requestedWei <= maximumWei &&
          payload.testnetOnly === true &&
          Number(payload.chainId) === 84532
        ) {
          const published = await publish(
            mcp,
            AUTONOMY_EVENT_TYPES.gasGrant,
            event,
            {
              schema: "agentpool.gas-grant/v1",
              chainId: 84532,
              sponsorAddress: wallet.address,
              recipientAddress: payload.recipientAddress,
              grantedWei: requestedWei.toString(),
              transferTransactionHash: null,
              state: "APPROVED_AWAITING_TEST_ETH_TRANSFER",
              testnetOnly: true,
              expiresAt: Math.min(
                Number(event.expiresAt),
                now + 60 * 60 * 1_000,
              ),
            },
            now,
          );
          outcomes.push({
            role: "GAS_SPONSOR",
            status: "grant-approved",
            eventId: published.id,
          });
        }
      }

      if (
        event.eventType === RUNNER_EVENT_TYPES.heartbeat &&
        roleEnabled(config, "WATCHER")
      ) {
        const issues = detectImprovementIssues(
          payload.metrics,
          config.watchRules,
        );
        for (const issue of issues) {
          const issueId = autonomyDigest({
            sourceEventId: event.id,
            issue,
          });
          const published = await publish(
            mcp,
            AUTONOMY_EVENT_TYPES.issue,
            event,
            {
              schema: "agentpool.improvement.issue/v1",
              issueId,
              reporterAddress: wallet.address,
              sourceEventId: event.id,
              evidence: issue,
              instruction:
                `Fix ${issue.issueType} without mutating the live Core. ` +
                "Produce a new isolated candidate release and reproducible evidence.",
              acceptanceCriteria: {
                metric: issue.metric,
                targetMaximum: issue.threshold,
                noSecurityRegression: true,
              },
              provider: config.improvementProvider,
              expiresAt: Math.min(
                Number(event.expiresAt),
                now + 7 * 24 * 60 * 60 * 1_000,
              ),
            },
            now,
          );
          outcomes.push({
            role: "WATCHER",
            status: "issue-published",
            issueId,
            eventId: published.id,
          });
        }
      }

      if (
        event.eventType === AUTONOMY_EVENT_TYPES.issue &&
        roleEnabled(config, "IMPROVER") &&
        executorRegistry
      ) {
        const provider = payload.provider ?? config.improvementProvider;
        const execution = await executorRegistry.execute({
          kind: "AGENT_EXECUTE",
          provider,
          instruction: [
            payload.instruction,
            "Work only in the isolated candidate workspace.",
            "A reward-eligible candidate requires evidence.changedFiles,",
            "evidence.testCommand, evidence.testPassed=true, and",
            "evidence.patchDigest. If writing or testing is blocked, report",
            "the blocker and do not claim successful implementation.",
          ].join("\n"),
          acceptanceCriteria: payload.acceptanceCriteria,
          networkAccess: false,
          workspaceMode: "ISOLATED_CANARY",
        });
        const candidateValidation =
          validateImprovementCandidateExecution(execution);
        if (!candidateValidation.valid) {
          outcomes.push({
            role: "IMPROVER",
            status: "candidate-rejected",
            reason: candidateValidation.reason,
            issueId: payload.issueId,
          });
          local.processed[key] = now;
          local.cursor = Math.max(
            local.cursor,
            Number(event.createdAt) + 1,
          );
          continue;
        }
        const published = await publish(
          mcp,
          RUNNER_EVENT_TYPES.improvementCandidate,
          event,
          {
            schema: "agentpool.improvement.candidate/v1",
            issueId: payload.issueId,
            authorAddress: wallet.address,
            provider,
            content: execution.content,
            evidence: candidateValidation.evidence,
            directCoreMutation: false,
            expiresAt: payload.expiresAt,
          },
          now,
        );
        outcomes.push({
          role: "IMPROVER",
          status: "candidate-published",
          eventId: published.id,
        });
      }

      if (
        event.eventType === RUNNER_EVENT_TYPES.improvementCandidate &&
        roleEnabled(config, "CANARY") &&
        String(event.actorAddress).toLowerCase() !==
          String(wallet.address).toLowerCase()
      ) {
        const candidateMetrics = payload.evidence?.candidateMetrics;
        const baselineMetrics = payload.evidence?.baselineMetrics;
        if (candidateMetrics && baselineMetrics) {
          const assessment = evaluateCanary(
            candidateMetrics,
            baselineMetrics,
            config.canaryThresholds,
          );
          const published = await publish(
            mcp,
            AUTONOMY_EVENT_TYPES.canary,
            event,
            {
              schema: "agentpool.canary.result/v1",
              proposalId: payload.issueId,
              candidateEventId: event.id,
              candidateAuthorAddress: payload.authorAddress,
              validatorAddress: wallet.address,
              candidate: candidateMetrics,
              baseline: baselineMetrics,
              thresholds: config.canaryThresholds ?? {},
              assessment,
              isolated: true,
              directCoreMutation: false,
              expiresAt: payload.expiresAt,
            },
            now,
          );
          outcomes.push({
            role: "CANARY",
            status: assessment.passed ? "proven" : "quarantined",
            eventId: published.id,
          });
        }
      }

      if (
        event.eventType === AUTONOMY_EVENT_TYPES.canary &&
        roleEnabled(config, "VOTER")
      ) {
        const assessment = evaluateCanary(
          payload.candidate,
          payload.baseline,
          payload.thresholds,
        );
        const published = await publish(
          mcp,
          AUTONOMY_EVENT_TYPES.vote,
          event,
          {
            schema: "agentpool.work-power.vote/v1",
            proposalId: payload.proposalId,
            voterAddress: wallet.address,
            operatorGroup: config.operatorGroup,
            support: assessment.passed,
            evidence: assessment,
            expiresAt: payload.expiresAt,
          },
          now,
        );
        outcomes.push({
          role: "VOTER",
          status: assessment.passed ? "support" : "oppose",
          eventId: published.id,
        });
      }

      local.processed[key] = now;
    } catch (error) {
      outcomes.push({
        role: "AUTONOMY",
        status: "error",
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    local.cursor = Math.max(local.cursor, Number(event.createdAt) + 1);
  }
  return { outcomes, state };
}

export async function runIdleImprovementCycle({
  config,
  mcp,
  state,
  wallet,
  executorRegistry,
  marketOutcomes = [],
  now = Date.now(),
}) {
  if (
    config.idleImprovement?.enabled === false ||
    !roleEnabled(config, "WATCHER") ||
    !roleEnabled(config, "IMPROVER") ||
    !executorRegistry
  ) {
    return { outcomes: [], state };
  }
  const local = autonomyState(state);
  local.idleImprovement ??= {
    lastAttemptAt: 0,
    lastAuditAt: 0,
    activeOpportunityId: null,
    activeIssueEventId: null,
    activeCandidateEventId: null,
  };
  const idle = local.idleImprovement;
  const outcomes = [];

  if (idle.activeOpportunityId) {
    const related = await mcp.call(
      "agentpool_v43_shared_coordination",
      {
        opportunityId: idle.activeOpportunityId,
        since: 0,
        limit: 200,
      },
    );
    const candidate = (related.events ?? []).find(
      (event) =>
        event.eventType ===
        RUNNER_EVENT_TYPES.improvementCandidate,
    );
    if (!candidate) {
      return {
        outcomes: [
          {
            role: "IDLE_IMPROVEMENT",
            status: "awaiting-candidate",
            opportunityId: idle.activeOpportunityId,
          },
        ],
        state,
      };
    }
    idle.activeCandidateEventId = candidate.id;
    idle.activeOpportunityId = null;
    idle.activeIssueEventId = null;
  }

  const interval = Number(
    config.idleImprovement?.auditIntervalMs ??
      60 * 60 * 1_000,
  );
  const retryInterval = Number(
    config.idleImprovement?.retryIntervalMs ??
      10 * 60 * 1_000,
  );
  if (
    now - Number(idle.lastAuditAt ?? 0) < interval ||
    now - Number(idle.lastAttemptAt ?? 0) < retryInterval
  ) {
    return { outcomes, state };
  }

  let bootstrap;
  try {
    bootstrap = await mcp.call(
      "agentpool_v437_self_bootstrap_status",
      {},
    );
  } catch (error) {
    idle.lastAttemptAt = now;
    outcomes.push({
      role: "IDLE_IMPROVEMENT",
      status: "unavailable",
      reason:
        error instanceof Error
          ? error.message
          : "SELF_BOOTSTRAP_STATUS_UNAVAILABLE",
    });
    return { outcomes, state };
  }
  if (
    bootstrap.open !== true ||
    Number(bootstrap.availableApool ?? 0) <= 0
  ) {
    idle.lastAttemptAt = now;
    outcomes.push({
      role: "IDLE_IMPROVEMENT",
      status: "no-budget",
    });
    return { outcomes, state };
  }

  const improvementReward = Math.min(
    Number(bootstrap.availableApool),
    Number(bootstrap.caps?.maxItemQuoteApool ?? 0),
  );
  const choices = [
    ...marketOutcomes
      .filter(
        (outcome) =>
          outcome.expectedNetProfitApool !== undefined,
      )
      .map((outcome) => ({
        id: `market:${outcome.eventId}`,
        market: outcome.market ?? "EXTERNAL",
        rewardApool: outcome.expectedNetProfitApool,
        successProbabilityBps: 10_000,
      })),
    {
      id: "system:idle-improvement-audit",
      market: "SYSTEM_IMPROVEMENT",
      rewardApool: String(improvementReward),
      successProbabilityBps: Number(
        config.idleImprovement?.successProbabilityBps ?? 7_500,
      ),
      estimatedCostApool: String(
        config.idleImprovement?.estimatedCostApool ?? "0",
      ),
      estimatedGasApool: String(
        config.idleImprovement?.estimatedGasApool ?? "0",
      ),
      failureLossApool: String(
        config.idleImprovement?.failureLossApool ?? "0",
      ),
    },
  ];
  const best = rankWorkChoicesByExpectedNetProfit(choices, {
    minimumNetProfitApool:
      config.minNetProfitApool ?? "0",
    capacityUnits: 1,
  })[0];
  if (!best || best.id !== "system:idle-improvement-audit") {
    outcomes.push({
      role: "IDLE_IMPROVEMENT",
      status: "higher-profit-market-work",
      selected: best?.id ?? null,
      expectedNetProfitApool:
        best?.expectedNetProfitApool ?? null,
    });
    return { outcomes, state };
  }

  idle.lastAttemptAt = now;
  let audit;
  try {
    audit = await executorRegistry.execute({
      kind: "AGENT_EXECUTE",
      provider:
        config.idleImprovement?.provider ??
        config.improvementProvider ??
        "codex",
      providerRequired: false,
      instruction: [
        "Audit the AgentPool source snapshot in the current isolated workspace.",
        "Identify exactly one highest-impact reproducible defect or missing",
        "economic or safety behavior. Do not invent work merely to earn a reward.",
        "Compare EXTERNAL and SYSTEM_IMPROVEMENT work by expected net profit;",
        "never prioritize a market type by name.",
        "If no actionable issue exists, set content to exactly",
        "NO_ACTIONABLE_ISSUE.",
        "Otherwise content must be one JSON object string with exactly these",
        "fields: status=ISSUE, title, affectedFiles (relative paths),",
        "reproductionSteps, impact, proposedFix, and acceptanceTest.",
        "The evidence summary and digest must describe the same reproduced issue.",
        "Do not access credentials, use the network, or mutate the live repository.",
      ].join(" "),
      acceptanceCriteria: {
        objectiveReproductionRequired: true,
        isolatedCandidateRequired: true,
        focusedTestRequired: true,
        noLiveCoreMutation: true,
      },
      networkAccess: false,
      workspaceMode: "ISOLATED_SOURCE_AUDIT",
    });
  } catch (error) {
    outcomes.push({
      role: "IDLE_IMPROVEMENT",
      status: "audit-error",
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcomes, state };
  }
  idle.lastAuditAt = now;
  const validation = validateIdleImprovementAudit(audit);
  if (validation.status !== "issue") {
    outcomes.push({
      role: "IDLE_IMPROVEMENT",
      status: validation.status,
      reason: validation.reason ?? null,
      provider: audit.provider,
    });
    return { outcomes, state };
  }
  const content = validation.canonicalContent;

  const issueId = autonomyDigest({
    schema: "agentpool.idle-improvement/v1",
    content,
    evidenceDigest: audit.evidence?.digest ?? null,
  });
  const opportunityId = `improvement:${issueId.slice(2, 34)}`;
  const expiresAt = now + 7 * 24 * 60 * 60 * 1_000;
  const published = await mcp.call(
    "agentpool_v43_publish_coordination",
    {
      eventType: AUTONOMY_EVENT_TYPES.issue,
      opportunityId,
      payloadJson: JSON.stringify({
        schema: "agentpool.improvement.issue/v1",
        issueId,
        reporterAddress: wallet.address,
        sourceEventId: null,
        evidence: {
          ...audit.evidence,
          structuredIssue: validation.issue,
          auditContent: content,
          expectedNetProfitApool:
            best.expectedNetProfitApool,
        },
        instruction: [
          JSON.stringify(validation.issue, null, 2),
          "Implement only in the isolated candidate workspace.",
          "Return changed-file and focused-test evidence; do not mutate live Core.",
        ].join("\n\n"),
        acceptanceCriteria: {
          objectiveReproductionRequired: true,
          focusedTestRequired: true,
          noSecurityRegression: true,
          noLiveCoreMutation: true,
        },
        provider:
          config.idleImprovement?.provider ??
          config.improvementProvider ??
          "codex",
        funding: "SELF_BOOTSTRAP_EXISTING_TAPOOL",
        rewardCapApool: String(improvementReward),
        createsWorkPower: false,
        canRecommendRelease: false,
        expiresAt,
      }),
      expiresAt,
    },
  );
  idle.activeOpportunityId = opportunityId;
  idle.activeIssueEventId = published.id;
  outcomes.push({
    role: "IDLE_IMPROVEMENT",
    status: "issue-published",
    issueId,
    opportunityId,
    eventId: published.id,
    expectedNetProfitApool: best.expectedNetProfitApool,
  });
  return { outcomes, state };
}

export async function runValidatorCycle({
  config,
  mcp,
  state,
  wallet,
  now = Date.now(),
}) {
  if (!roleEnabled(config, "VALIDATOR")) {
    return { outcomes: [], state };
  }
  const local = autonomyState(state);
  const relay = await mcp.call("agentpool_v43_shared_coordination", {
    eventType: RUNNER_EVENT_TYPES.result,
    since: 0,
    limit: 200,
  });
  const outcomes = [];
  for (const resultEvent of relay.events ?? []) {
    if (
      ["SETTLED", "REJECTED"].includes(
        local.validations[resultEvent.id]?.stage,
      )
    ) {
      continue;
    }
    const resultPayload = unwrapCoordinationEvent(resultEvent);
    const related = await mcp.call("agentpool_v43_shared_coordination", {
      opportunityId: resultEvent.opportunityId,
      since: 0,
      limit: 200,
    });
    const termsEvent = (related.events ?? []).find(
      (event) => event.eventType === RUNNER_EVENT_TYPES.terms,
    );
    if (!termsEvent) continue;
    const terms = unwrapCoordinationEvent(termsEvent);
    const settledNotice = (related.events ?? []).find((event) => {
      if (event.eventType !== RUNNER_EVENT_TYPES.settlement) return false;
      const payload = unwrapCoordinationEvent(event);
      return (
        String(payload.jobId).toLowerCase() ===
          String(terms.jobId).toLowerCase() &&
        Number(payload.milestone ?? 0) === Number(terms.milestone ?? 0)
      );
    });
    if (settledNotice) {
      local.validations[resultEvent.id] = {
        stage: "SETTLED",
        settlementEventId: settledNotice.id,
        updatedAt: now,
      };
      continue;
    }
    if (
      String(terms.validatorAddress).toLowerCase() !==
      String(wallet.address).toLowerCase()
    ) {
      continue;
    }
    if (
      String(resultEvent.actorAddress).toLowerCase() !==
      String(terms.workerAddress).toLowerCase()
    ) {
      continue;
    }
    let result = resultPayload.result;
    if (!result && resultPayload.privateResultEnvelope) {
      if (!config.privateChannelPrivateKey) {
        outcomes.push({
          role: "VALIDATOR",
          status: "skipped",
          reason: "PRIVATE_CHANNEL_KEY_REQUIRED",
        });
        continue;
      }
      const opened = await openPrivateJson(
        config.privateChannelPrivateKey,
        resultPayload.privateResultEnvelope,
      );
      result = opened.result;
    }
    const validation = terms.expectedDeliveryHash
      ? {
          passed:
            keccak256(toBytes(String(result ?? ""))).toLowerCase() ===
            String(terms.expectedDeliveryHash).toLowerCase(),
          scoreBps:
            keccak256(toBytes(String(result ?? ""))).toLowerCase() ===
            String(terms.expectedDeliveryHash).toLowerCase()
              ? 10_000
              : 0,
          reason: "KECCAK256_COMMITMENT",
        }
      : validateExecutionResult({
          result: {
            schema: "agentpool.executor.result/v1",
            content: String(result ?? ""),
          },
          policy: "EXACT",
          deterministicExpected: terms.expectedDelivery,
        });
    const record = (local.validations[resultEvent.id] ??= {});
    if (!validation.passed) {
      record.stage = "REJECTED";
      record.updatedAt = now;
      const published = await publish(
        mcp,
        AUTONOMY_EVENT_TYPES.validation,
        resultEvent,
        {
          schema: "agentpool.autonomy.validation/v1",
          validatorAddress: wallet.address,
          jobId: terms.jobId,
          milestone: terms.milestone,
          ...validation,
          expiresAt: Number(terms.deadline) * 1_000,
        },
        now,
      );
      outcomes.push({
        role: "VALIDATOR",
        status: "rejected",
        eventId: published.id,
      });
      continue;
    }
    const receipt = await mcp.call(
      "agentpool_v43_resolve_milestone_onchain",
      {
        jobId: terms.jobId,
        milestone: Number(terms.milestone),
        proofText: terms.proofText,
        recipients: terms.recipients,
        amountsApool: terms.amountsApool,
      },
    );
    record.stage = "SETTLED";
    record.transactionHash = receipt.transactionHash;
    record.updatedAt = now;
    const published = await publish(
      mcp,
      RUNNER_EVENT_TYPES.settlement,
      resultEvent,
      {
        schema: "agentpool.runner.settlement/v1",
        chainId: 84532,
        jobId: terms.jobId,
        milestone: Number(terms.milestone),
        buyerAddress: terms.buyerAddress,
        workerAddress: terms.workerAddress,
        validatorAddress: wallet.address,
        settlementTransactionHash: receipt.transactionHash,
        emissionApool: "0",
        independentValidation: true,
        expiresAt: Number(terms.deadline) * 1_000,
      },
      now,
    );
    outcomes.push({
      role: "VALIDATOR",
      status: "settled",
      eventId: published.id,
      transactionHash: receipt.transactionHash,
    });
  }
  return { outcomes, state };
}

export async function sealRunnerResultForBuyer(
  result,
  recipientPublicKey,
  jobId,
) {
  return sealPrivateJson(
    recipientPublicKey,
    { schema: "agentpool.private-result/v1", jobId, result },
    `AgentPool private result ${jobId}`,
  );
}

export function newValidationSalt() {
  return `validation:${randomBytes(32).toString("hex")}`;
}
