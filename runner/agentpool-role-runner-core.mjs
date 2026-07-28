import { randomBytes } from "node:crypto";
import { keccak256, toBytes } from "viem";
import {
  AUTONOMY_EVENT_TYPES,
  autonomyDigest,
  buildTaskDag,
  createRiskAdjustedBid,
  detectImprovementIssues,
  evaluateCanary,
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
        const profiles = config.bidProfiles ?? [];
        for (const task of payload.tasks ?? []) {
          for (const profile of profiles.filter(
            (candidate) =>
              candidate.capability === task.capability &&
              candidate.enabled !== false,
          )) {
            const bid = createRiskAdjustedBid(task, {
              ...profile,
              bidderAddress: wallet.address,
              operatorGroup: config.operatorGroup,
              expiresAt: Math.min(
                Number(profile.expiresAt ?? now + 10 * 60 * 1_000),
                Number(event.expiresAt),
              ),
            });
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
              eventId: published.id,
            });
          }
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
          instruction: payload.instruction,
          acceptanceCriteria: payload.acceptanceCriteria,
          networkAccess: false,
          workspaceMode: "ISOLATED_CANARY",
        });
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
            evidence: execution.evidence,
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
