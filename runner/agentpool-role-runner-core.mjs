import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256, parseUnits, toBytes } from "viem";
import {
  AUTONOMY_EVENT_TYPES,
  autonomyDigest,
  buildTaskDag,
  createRiskAdjustedBid,
  detectImprovementIssues,
  evaluateCanary,
  performanceProfileKey,
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
import { verifyPublishedCandidateArtifact } from "./execution-adapters.mjs";

function roleEnabled(config, role) {
  return (config.roles ?? ["WORKER"]).includes(role);
}

function autonomyState(state) {
  state.autonomy ??= {
    cursor: 0,
    processed: {},
    validations: {},
    candidateRewards: {},
  };
  state.autonomy.candidateRewards ??= {};
  return state.autonomy;
}

function candidateRewardRecord(state, issueId) {
  const local = autonomyState(state);
  local.candidateRewards[issueId] ??= {
    stage: "DISCOVERED",
    plan: null,
    planSalt: null,
    planCommitment: null,
    validationSalt: null,
    validationScoreBps: null,
    validationEvidenceDigest: null,
    terminal: false,
  };
  return local.candidateRewards[issueId];
}

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
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

export async function readVerifiedPerformanceForBids(
  mcp,
  bids,
  { lookback = 8 } = {},
) {
  const profiles = new Map();
  for (const bid of bids) {
    const key = performanceProfileKey({
      bidderAddress: bid.bidderAddress,
      capability: bid.capability,
      runtimeHash: bid.runtimeHash,
    });
    if (profiles.has(key)) continue;
    const result = await mcp.call(
      "agentpool_v43_verified_performance",
      {
        agent: bid.bidderAddress,
        runtimeHash: bid.runtimeHash ?? "UNATTESTED_RUNTIME",
        capability: bid.capability,
        lookback,
      },
    );
    if (!result.rankEligible) {
      profiles.set(key, null);
      continue;
    }
    const attempts = Number(result.attempts);
    const successes = Number(result.successes);
    if (
      !Number.isSafeInteger(attempts) ||
      !Number.isSafeInteger(successes) ||
      attempts < 0 ||
      successes < 0 ||
      successes > attempts
    ) {
      throw new Error("AUTONOMY_CHAIN_PERFORMANCE_INVALID");
    }
    profiles.set(key, { attempts, successes });
  }
  return Object.fromEntries(
    [...profiles.entries()].filter(([, record]) => record !== null),
  );
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

function hasExactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") ===
      [...expected].sort().join("\0")
  );
}

function pathInside(parent, candidate) {
  const relative = path.relative(
    path.resolve(parent),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function validateIdleImprovementAudit(
  audit,
  { workspaceRoot } = {},
) {
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
  const exactIssueFields = [
    "status",
    "title",
    "affectedFiles",
    "reproductionSteps",
    "impact",
    "proposedFix",
    "acceptanceTest",
  ];
  if (
    !hasExactKeys(issue, exactIssueFields) ||
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
    !/^[A-Za-z0-9._:-]+$/.test(audit.evidence.digest) ||
    !validAuditText(audit?.evidence?.testCommand, 3, 1_000) ||
    audit?.evidence?.testPassed !== true
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
  if (workspaceRoot) {
    const missingOrEscaped = canonicalIssue.affectedFiles.some((file) => {
      const absolute = path.resolve(workspaceRoot, file);
      return (
        !pathInside(workspaceRoot, absolute) ||
        !fs.existsSync(absolute) ||
        !fs.statSync(absolute).isFile()
      );
    });
    if (missingOrEscaped) {
      return {
        status: "invalid-audit-evidence",
        reason: "AUDIT_AFFECTED_FILE_NOT_FOUND",
      };
    }
  }
  const canonicalContent = JSON.stringify(canonicalIssue);
  const evidenceDigest = `sha256:${createHash("sha256")
    .update(canonicalContent)
    .update("\n")
    .update(audit.evidence.summary.trim())
    .update("\n")
    .update(audit.evidence.testCommand.trim())
    .digest("hex")}`;
  return {
    status: "issue",
    issue: canonicalIssue,
    canonicalContent,
    evidenceDigest,
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
    !validAuditText(evidence.sourceSnapshotDigest, 8, 200) ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.sourceSnapshotDigest) ||
    !validAuditText(evidence.artifactDigest, 8, 200) ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.artifactDigest) ||
    !Number.isSafeInteger(evidence.artifactSizeBytes) ||
    evidence.artifactSizeBytes <= 0 ||
    evidence.objectiveCanaryPassed !== true ||
    !evidence.candidateMetrics ||
    !evidence.baselineMetrics ||
    Number(evidence.candidateMetrics.qualityBps) <=
      Number(evidence.baselineMetrics.qualityBps) ||
    Number(evidence.candidateMetrics.securityRegressions ?? 1) !== 0 ||
    evidence.hostVerified !== true ||
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
      sourceSnapshotDigest: evidence.sourceSnapshotDigest.trim(),
      artifactDigest: evidence.artifactDigest.trim(),
      artifactSizeBytes: evidence.artifactSizeBytes,
      objectiveCanaryPassed: true,
      objectiveCanaryReason: evidence.objectiveCanaryReason,
      candidateMetrics: evidence.candidateMetrics,
      baselineMetrics: evidence.baselineMetrics,
      hostVerified: true,
    },
  };
}

async function executeImprovementCandidate({
  payload,
  provider,
  executorRegistry,
}) {
  const execution = await executorRegistry.execute({
    kind: "AGENT_EXECUTE",
    provider,
    instruction: [
      payload.instruction,
      "The current source snapshot is disposable and writable.",
      "Implement the fix now by editing only that isolated workspace.",
      "Run the focused regression test before returning.",
      "Do not merely propose a patch or repeat the issue report.",
      "A reward-eligible candidate requires evidence.changedFiles,",
      "evidence.testCommand, evidence.testPassed=true, and",
      "evidence.patchDigest. If writing or testing is blocked, report",
      "the blocker and do not claim successful implementation.",
    ].join("\n"),
    acceptanceCriteria: payload.acceptanceCriteria,
    networkAccess: false,
    workspaceMode: "ISOLATED_CANARY",
  });
  return {
    execution,
    validation: validateImprovementCandidateExecution(execution),
  };
}

function improvementSourceStatus(payload, config) {
  if (config.requirePinnedImprovementIssues !== true) {
    return { valid: true };
  }
  if (
    typeof payload.sourceSnapshotDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.sourceSnapshotDigest)
  ) {
    return {
      valid: false,
      reason: "ISSUE_SOURCE_SNAPSHOT_UNPINNED",
    };
  }
  if (
    typeof config.sourceSnapshotDigest !== "string" ||
    payload.sourceSnapshotDigest !== config.sourceSnapshotDigest
  ) {
    return {
      valid: false,
      reason: "ISSUE_SOURCE_SNAPSHOT_SUPERSEDED",
    };
  }
  return { valid: true };
}

async function publishImprovementCandidate({
  mcp,
  event,
  payload,
  wallet,
  provider,
  execution,
  validation,
  config,
  now,
}) {
  const localArtifactPath =
    execution.evidence?.localArtifactPath ?? null;
  const artifactJson =
    typeof execution.evidence?.artifactJson === "string"
      ? execution.evidence.artifactJson
      : localArtifactPath
        ? await fs.promises.readFile(localArtifactPath, "utf8")
        : null;
  if (!artifactJson) {
    throw new Error("CANDIDATE_PUBLIC_ARTIFACT_REQUIRED");
  }
  const artifact = await mcp.call(
    "agentpool_v43_publish_candidate_artifact",
    {
      artifactDigest: validation.evidence.artifactDigest,
      artifactJson,
    },
  );
  if (
    artifact.artifactDigest !== validation.evidence.artifactDigest ||
    artifact.sourceSnapshotDigest !==
      validation.evidence.sourceSnapshotDigest ||
    artifact.patchDigest !== validation.evidence.patchDigest ||
    artifact.immutable !== true
  ) {
    throw new Error("CANDIDATE_PUBLIC_ARTIFACT_RECEIPT_INVALID");
  }
  return publish(
    mcp,
    RUNNER_EVENT_TYPES.improvementCandidate,
    event,
    {
      schema: "agentpool.improvement.candidate/v1",
      issueId: payload.issueId,
      authorAddress: wallet.address,
      operatorGroup: config.operatorGroup ?? null,
      runtime: config.runtime ?? null,
      independenceClaim: config.independenceClaim === true,
      provider,
      content: execution.content,
      evidence: {
        ...validation.evidence,
        artifactPublicPath: artifact.publicPath,
        artifactAuthorAddress: artifact.authorAddress,
      },
      sourceSnapshotDigest: payload.sourceSnapshotDigest,
      directCoreMutation: false,
      expiresAt: payload.expiresAt,
    },
    now,
  );
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
              runtimeHash:
                profile.runtimeHash ??
                config.sourceSnapshotDigest ??
                config.runtime ??
                "UNATTESTED_RUNTIME",
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
            const verifiedPerformance =
              await readVerifiedPerformanceForBids(mcp, bids, {
                lookback: Number(
                  config.verifiedPerformanceLookback ?? 8,
                ),
              });
            const award = selectWinningBids(plan, bids, {
              verifiedPerformance,
            });
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
              sourceSnapshotDigest: config.sourceSnapshotDigest,
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
        if (config.candidateReward?.enabled === true) {
          const reward = candidateRewardRecord(
            state,
            payload.issueId,
          );
          if (reward.stage !== "RUNNING_SELECTED") {
            outcomes.push({
              role: "IMPROVER",
              status: "awaiting-prework-reward-award",
              issueId: payload.issueId,
              rewardStage: reward.stage,
            });
            local.processed[key] = now;
            local.cursor = Math.max(
              local.cursor,
              Number(event.createdAt) + 1,
            );
            continue;
          }
        }
        const sourceStatus = improvementSourceStatus(payload, config);
        if (!sourceStatus.valid) {
          outcomes.push({
            role: "IMPROVER",
            status: "candidate-superseded",
            reason: sourceStatus.reason,
            issueId: payload.issueId,
          });
          if (
            local.idleImprovement?.activeOpportunityId ===
            event.opportunityId
          ) {
            local.idleImprovement.activeOpportunityId = null;
            local.idleImprovement.activeIssueEventId = null;
            local.idleImprovement.candidateAttemptCount = 0;
          }
          local.processed[key] = now;
          local.cursor = Math.max(
            local.cursor,
            Number(event.createdAt) + 1,
          );
          continue;
        }
        const attempt = await executeImprovementCandidate({
          payload,
          provider,
          executorRegistry,
        });
        if (
          local.idleImprovement?.activeOpportunityId ===
          event.opportunityId
        ) {
          local.idleImprovement.lastCandidateAttemptAt = now;
          local.idleImprovement.candidateAttemptCount =
            Number(
              local.idleImprovement.candidateAttemptCount ?? 0,
            ) + 1;
        }
        if (!attempt.validation.valid) {
          outcomes.push({
            role: "IMPROVER",
            status: "candidate-rejected",
            reason: attempt.validation.reason,
            issueId: payload.issueId,
          });
          local.processed[key] = now;
          local.cursor = Math.max(
            local.cursor,
            Number(event.createdAt) + 1,
          );
          continue;
        }
        const published = await publishImprovementCandidate({
          mcp,
          event,
          payload,
          wallet,
          provider,
          execution: attempt.execution,
          validation: attempt.validation,
          config,
          now,
        });
        outcomes.push({
          role: "IMPROVER",
          status: "candidate-published",
          eventId: published.id,
        });
      }

      if (
        event.eventType === RUNNER_EVENT_TYPES.improvementCandidate &&
        roleEnabled(config, "CANARY")
      ) {
        let candidateMetrics = payload.evidence?.candidateMetrics;
        let baselineMetrics = payload.evidence?.baselineMetrics;
        let independentReplay = null;
        if (config.candidateVerification?.baseWorkspace) {
          const downloaded = await mcp.call(
            "agentpool_v43_candidate_artifact",
            {
              artifactDigest: payload.evidence?.artifactDigest,
            },
          );
          independentReplay =
            await verifyPublishedCandidateArtifact({
              baseWorkspace:
                config.candidateVerification.baseWorkspace,
              artifactJson: downloaded.artifactJson,
              artifactDigest: payload.evidence.artifactDigest,
              targetRoot:
                config.candidateVerification.targetRoot,
              config:
                config.candidateVerification.executorConfig ?? {},
            });
          if (
            downloaded.artifactDigest !==
              payload.evidence.artifactDigest ||
            independentReplay.sourceSnapshotDigest !==
              payload.evidence.sourceSnapshotDigest ||
            independentReplay.patchDigest !==
              payload.evidence.patchDigest ||
            independentReplay.objectiveCanaryPassed !== true
          ) {
            throw new Error(
              "CANDIDATE_INDEPENDENT_REPLAY_MISMATCH",
            );
          }
          candidateMetrics = independentReplay.candidateMetrics;
          baselineMetrics = independentReplay.baselineMetrics;
        }
        if (candidateMetrics && baselineMetrics) {
          const independent =
            String(event.actorAddress).toLowerCase() !==
              String(wallet.address).toLowerCase() &&
            payload.independenceClaim === true &&
            config.independenceClaim === true &&
            typeof payload.operatorGroup === "string" &&
            payload.operatorGroup.length > 0 &&
            typeof config.operatorGroup === "string" &&
            config.operatorGroup.length > 0 &&
            payload.operatorGroup !== config.operatorGroup &&
            independentReplay !== null;
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
              independent,
              candidateIndependenceClaim:
                payload.independenceClaim === true,
              validatorIndependenceClaim:
                config.independenceClaim === true,
              candidateOperatorGroup:
                payload.operatorGroup ?? null,
              validatorOperatorGroup:
                config.operatorGroup ?? null,
              advisoryOnly: !independent,
              artifactDigest: payload.evidence?.artifactDigest,
              patchDigest: payload.evidence?.patchDigest,
              sourceSnapshotDigest:
                payload.evidence?.sourceSnapshotDigest,
              replayedArtifact: independentReplay !== null,
              createsWorkPower: false,
              rewardEligible: independent && assessment.passed,
              directCoreMutation: false,
              expiresAt: payload.expiresAt,
            },
            now,
          );
          outcomes.push({
            role: "CANARY",
            status: !independent
              ? "advisory-only"
              : assessment.passed
                ? "proven"
                : "quarantined",
            eventId: published.id,
          });
        }
      }

      if (
        event.eventType === AUTONOMY_EVENT_TYPES.canary &&
        roleEnabled(config, "VOTER")
      ) {
        if (payload.independent !== true) {
          outcomes.push({
            role: "VOTER",
            status: "skipped",
            reason: "INDEPENDENT_CANARY_REQUIRED",
            eventId: event.id,
          });
          local.processed[key] = now;
          local.cursor = Math.max(
            local.cursor,
            Number(event.createdAt) + 1,
          );
          continue;
        }
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
      break;
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
    candidateAttemptCount: 0,
    lastCandidateAttemptAt: 0,
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
      const maximumCandidateAttempts = Number(
        config.idleImprovement?.maximumCandidateAttempts ?? 3,
      );
      if (
        Number(idle.candidateAttemptCount ?? 0) >=
        maximumCandidateAttempts
      ) {
        const abandoned = idle.activeIssueEventId;
        idle.activeOpportunityId = null;
        idle.activeIssueEventId = null;
        idle.activeCandidateEventId = null;
        idle.candidateAttemptCount = 0;
        return {
          outcomes: [
            {
              role: "IDLE_IMPROVEMENT",
              status: "candidate-abandoned",
              issueEventId: abandoned,
              reason: "MAXIMUM_CANDIDATE_ATTEMPTS_REACHED",
            },
          ],
          state,
        };
      }
      const candidateRetryInterval = Number(
        config.idleImprovement?.candidateRetryIntervalMs ??
          10 * 60 * 1_000,
      );
      const issueEvent = (related.events ?? []).find(
        (event) =>
          event.eventType === AUTONOMY_EVENT_TYPES.issue &&
          event.id === idle.activeIssueEventId,
      );
      if (issueEvent) {
        const issuePayload = unwrapCoordinationEvent(issueEvent);
        const sourceStatus = improvementSourceStatus(
          issuePayload,
          config,
        );
        if (!sourceStatus.valid) {
          const superseded = idle.activeIssueEventId;
          idle.activeOpportunityId = null;
          idle.activeIssueEventId = null;
          idle.activeCandidateEventId = null;
          idle.candidateAttemptCount = 0;
          return {
            outcomes: [
              {
                role: "IDLE_IMPROVEMENT",
                status: "candidate-superseded",
                issueEventId: superseded,
                reason: sourceStatus.reason,
              },
            ],
            state,
          };
        }
      }
      if (issueEvent && config.candidateReward?.enabled === true) {
        const issuePayload = unwrapCoordinationEvent(issueEvent);
        const reward = candidateRewardRecord(
          state,
          issuePayload.issueId,
        );
        if (reward.stage !== "RUNNING_SELECTED") {
          return {
            outcomes: [
              {
                role: "IDLE_IMPROVEMENT",
                status: "awaiting-prework-reward-award",
                issueId: issuePayload.issueId,
                rewardStage: reward.stage,
              },
            ],
            state,
          };
        }
      }
      if (
        issueEvent &&
        now - Number(idle.lastCandidateAttemptAt ?? 0) >=
          candidateRetryInterval
      ) {
        const payload = unwrapCoordinationEvent(issueEvent);
        const provider =
          payload.provider ?? config.improvementProvider ?? "codex";
        idle.lastCandidateAttemptAt = now;
        idle.candidateAttemptCount =
          Number(idle.candidateAttemptCount ?? 0) + 1;
        try {
          const attempt = await executeImprovementCandidate({
            payload,
            provider,
            executorRegistry,
          });
          if (!attempt.validation.valid) {
            return {
              outcomes: [
                {
                  role: "IDLE_IMPROVEMENT",
                  status: "candidate-rejected",
                  reason: attempt.validation.reason,
                  issueId: payload.issueId,
                },
              ],
              state,
            };
          }
          const published = await publishImprovementCandidate({
            mcp,
            event: issueEvent,
            payload,
            wallet,
            provider,
            execution: attempt.execution,
            validation: attempt.validation,
            config,
            now,
          });
          idle.activeCandidateEventId = published.id;
          idle.activeOpportunityId = null;
          idle.activeIssueEventId = null;
          idle.candidateAttemptCount = 0;
          return {
            outcomes: [
              {
                role: "IDLE_IMPROVEMENT",
                status: "candidate-published",
                eventId: published.id,
                issueId: payload.issueId,
              },
            ],
            state,
          };
        } catch (error) {
          return {
            outcomes: [
              {
                role: "IDLE_IMPROVEMENT",
                status: "candidate-error",
                error:
                  error instanceof Error
                    ? error.message
                    : String(error),
              },
            ],
            state,
          };
        }
      }
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
  const validation = validateIdleImprovementAudit(audit, {
    workspaceRoot:
      config.executors?.[audit.provider]?.workspace ?? null,
  });
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
    evidenceDigest: validation.evidenceDigest,
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
          digest: validation.evidenceDigest,
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
        sourceSnapshotDigest: config.sourceSnapshotDigest,
        funding: "UNFUNDED_ADVISORY_UNTIL_CANDIDATE_VERIFIED",
        rewardCapApool: "0",
        candidateRewardCapApool: String(improvementReward),
        createsWorkPower: false,
        canRecommendRelease: false,
        expiresAt,
      }),
      expiresAt,
    },
  );
  idle.activeOpportunityId = opportunityId;
  idle.activeIssueEventId = published.id;
  idle.candidateAttemptCount = 0;
  idle.lastCandidateAttemptAt = 0;
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

export async function runCandidateRewardSettlementCycle({
  config,
  mcp,
  state,
  wallet,
  now = Date.now(),
}) {
  if (config.candidateReward?.enabled !== true) {
    return { outcomes: [], state };
  }
  const outcomes = [];
  let status;
  try {
    status = await mcp.call(
      "agentpool_v439_candidate_reward_status",
      {},
    );
  } catch (error) {
    return {
      outcomes: [
        {
          role: "CANDIDATE_REWARD",
          status: "unavailable",
          error:
            error instanceof Error ? error.message : String(error),
        },
      ],
      state,
    };
  }
  if (status.deployed !== true) {
    return {
      outcomes: [
        {
          role: "CANDIDATE_REWARD",
          status: "deployment-pending",
          reason:
            status.reason ?? "BASE_SEPOLIA_DEPLOYMENT_PENDING",
        },
      ],
      state,
    };
  }

  const relay = await mcp.call(
    "agentpool_v43_shared_coordination",
    {
      eventType: AUTONOMY_EVENT_TYPES.issue,
      since: 0,
      limit: 100,
    },
  );
  const issueEvents = [...(relay.events ?? [])].sort(
    (left, right) =>
      Number(left.createdAt) - Number(right.createdAt),
  );
  const local = autonomyState(state);
  const activeIssueId = local.candidateRewardActiveIssueId;
  let selectedEvents = activeIssueId
    ? issueEvents.filter(
        (event) =>
          unwrapCoordinationEvent(event).issueId === activeIssueId,
      )
    : [];
  if (selectedEvents.length === 0) {
    local.candidateRewardActiveIssueId = null;
    const configuredCandidateQuote = String(
      config.candidateReward.candidateQuoteApool ?? "1",
    );
    const configuredReporterQuote = String(
      config.candidateReward.reporterQuoteApool ?? "0.1",
    );
    const configuredValidatorQuote = String(
      config.candidateReward.validatorQuoteApool ?? "0.2",
    );
    const choices = issueEvents.map((event) => {
      const payload = unwrapCoordinationEvent(event);
      const reward =
        Number(configuredCandidateQuote) +
        (sameAddress(event.actorAddress, wallet.address)
          ? Number(configuredReporterQuote)
          : 0) +
        (roleEnabled(config, "CANARY")
          ? Number(configuredValidatorQuote)
          : 0);
      return {
        id: payload.issueId,
        rewardApool: String(reward),
        successProbabilityBps: Number(
          config.candidateReward.successProbabilityBps ?? 7_500,
        ),
        estimatedCostApool: String(
          config.candidateReward.estimatedCostApool ??
            config.idleImprovement?.estimatedCostApool ??
            "0",
        ),
        estimatedGasApool: String(
          config.candidateReward.estimatedGasApool ??
            config.idleImprovement?.estimatedGasApool ??
            "0",
        ),
        failureLossApool: String(
          config.candidateReward.failureLossApool ??
            config.idleImprovement?.failureLossApool ??
            "0",
        ),
      };
    });
    const best = rankWorkChoicesByExpectedNetProfit(choices, {
      minimumNetProfitApool: config.minNetProfitApool ?? "0",
      capacityUnits: 1,
    })[0];
    if (!best) return { outcomes, state };
    selectedEvents = issueEvents.filter(
      (event) =>
        unwrapCoordinationEvent(event).issueId === best.id,
    );
    local.candidateRewardActiveIssueId = best.id;
  }
  const nowSeconds = Math.floor(now / 1_000);
  for (const event of selectedEvents) {
    const payload = unwrapCoordinationEvent(event);
    if (!payload.issueId || Number(event.expiresAt) <= now) continue;
    const record = candidateRewardRecord(state, payload.issueId);
    if (record.terminal) continue;
    try {
      let issue = await mcp.call(
        "agentpool_v439_candidate_reward_issue",
        { issueId: payload.issueId },
      );
      if (
        issue.state === "NONE" &&
        sameAddress(event.actorAddress, wallet.address)
      ) {
        const reporterQuoteApool = String(
          config.candidateReward.reporterQuoteApool ?? "0.1",
        );
        const candidateQuoteApool = String(
          config.candidateReward.candidateQuoteApool ?? "1",
        );
        const validatorQuoteApool = String(
          config.candidateReward.validatorQuoteApool ?? "0.2",
        );
        const budgetCapApool = String(
          config.candidateReward.budgetCapApool ??
            Number(reporterQuoteApool) +
              Number(candidateQuoteApool) +
              Number(validatorQuoteApool),
        );
        await mcp.call(
          "agentpool_v439_open_candidate_reward_issue",
          {
            issueId: payload.issueId,
            issueDigest:
              payload.evidence?.digest ??
              autonomyDigest({
                issueId: payload.issueId,
                evidence: payload.evidence ?? null,
              }),
            sourceSnapshotDigest: payload.sourceSnapshotDigest,
            acceptanceDigest: autonomyDigest(
              payload.acceptanceCriteria ?? {},
            ),
            budgetCapApool,
            reporterQuoteApool,
            bidMinutes: Number(
              config.candidateReward.bidMinutes ?? 5,
            ),
            deliveryMinutes: Number(
              config.candidateReward.deliveryMinutes ?? 60,
            ),
            commitMinutes: Number(
              config.candidateReward.commitMinutes ?? 90,
            ),
            revealMinutes: Number(
              config.candidateReward.revealMinutes ?? 120,
            ),
          },
        );
        record.stage = "BIDDING";
        record.reporterQuoteApool = reporterQuoteApool;
        record.candidateQuoteApool = candidateQuoteApool;
        record.validatorQuoteApool = validatorQuoteApool;
        outcomes.push({
          role: "CANDIDATE_REWARD",
          status: "issue-opened",
          issueId: payload.issueId,
          budgetCapApool,
        });
        continue;
      }
      if (issue.state === "NONE") continue;

      if (issue.state === "BIDDING") {
        const ownBid = (issue.candidates ?? []).find((candidate) =>
          sameAddress(candidate.author, wallet.address),
        );
        if (!ownBid && nowSeconds <= issue.deadlines.bid) {
          record.plan ??= JSON.stringify({
            schema: "agentpool.candidate.plan/v1",
            issueId: payload.issueId,
            sourceSnapshotDigest: payload.sourceSnapshotDigest,
            acceptanceDigest: autonomyDigest(
              payload.acceptanceCriteria ?? {},
            ),
          });
          record.planSalt ??= `0x${randomBytes(32).toString("hex")}`;
          const prepared = await mcp.call(
            "agentpool_v439_prepare_candidate_bid",
            {
              issueId: payload.issueId,
              plan: record.plan,
              planSalt: record.planSalt,
            },
          );
          await mcp.call(
            "agentpool_v439_submit_candidate_bid",
            {
              issueId: payload.issueId,
              quoteApool: String(
                record.candidateQuoteApool ??
                  config.candidateReward.candidateQuoteApool ??
                  "1",
              ),
              planCommitment: prepared.planCommitment,
            },
          );
          record.planCommitment = prepared.planCommitment;
          record.stage = "BID_SUBMITTED";
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "candidate-bid-submitted",
            issueId: payload.issueId,
          });
          continue;
        }
        if (nowSeconds > issue.deadlines.bid) {
          await mcp.call("agentpool_v439_award_candidate", {
            issueId: payload.issueId,
          });
          record.stage = "AWARD_PENDING";
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "candidate-awarded",
            issueId: payload.issueId,
          });
        }
        continue;
      }

      if (issue.state === "RUNNING") {
        const selected = (issue.candidates ?? []).find(
          (candidate) =>
            Number(candidate.candidateId) ===
            Number(issue.selectedCandidateId),
        );
        if (!selected || !sameAddress(selected.author, wallet.address)) {
          record.stage = "RUNNING_OTHER_CANDIDATE";
          continue;
        }
        record.stage = "RUNNING_SELECTED";
        const related = await mcp.call(
          "agentpool_v43_shared_coordination",
          {
            opportunityId: event.opportunityId,
            since: 0,
            limit: 200,
          },
        );
        const candidate = (related.events ?? []).find(
          (candidateEvent) =>
            candidateEvent.eventType ===
              RUNNER_EVENT_TYPES.improvementCandidate &&
            sameAddress(
              candidateEvent.actorAddress,
              wallet.address,
            ),
        );
        if (!candidate) {
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "awaiting-selected-candidate-delivery",
            issueId: payload.issueId,
          });
          continue;
        }
        const candidatePayload = unwrapCoordinationEvent(candidate);
        await mcp.call("agentpool_v439_deliver_candidate", {
          issueId: payload.issueId,
          plan: record.plan,
          planSalt: record.planSalt,
          artifactDigest:
            candidatePayload.evidence.artifactDigest,
          patchDigest: candidatePayload.evidence.patchDigest,
        });
        record.stage = "VALIDATING";
        record.candidateEventId = candidate.id;
        outcomes.push({
          role: "CANDIDATE_REWARD",
          status: "candidate-delivered",
          issueId: payload.issueId,
          artifactDigest:
            candidatePayload.evidence.artifactDigest,
        });
        continue;
      }

      if (issue.state === "VALIDATING") {
        record.stage = "VALIDATING";
        const ownValidation = (issue.validations ?? []).find(
          (validation) =>
            sameAddress(validation.validator, wallet.address),
        );
        const related = await mcp.call(
          "agentpool_v43_shared_coordination",
          {
            opportunityId: event.opportunityId,
            since: 0,
            limit: 200,
          },
        );
        const canary = [...(related.events ?? [])]
          .reverse()
          .find(
            (canaryEvent) =>
              canaryEvent.eventType === AUTONOMY_EVENT_TYPES.canary &&
              unwrapCoordinationEvent(canaryEvent)
                .artifactDigest === issue.artifactDigest,
          );
        if (
          !ownValidation &&
          canary &&
          nowSeconds <= issue.deadlines.commit
        ) {
          const canaryPayload = unwrapCoordinationEvent(canary);
          record.validationScoreBps =
            canaryPayload.assessment?.passed === true ? 10_000 : 0;
          record.validationEvidenceDigest = autonomyDigest({
            artifactDigest: issue.artifactDigest,
            assessment: canaryPayload.assessment,
            candidate: canaryPayload.candidate,
            baseline: canaryPayload.baseline,
            replayedArtifact: canaryPayload.replayedArtifact,
          });
          record.validationSalt ??=
            `0x${randomBytes(32).toString("hex")}`;
          const prepared = await mcp.call(
            "agentpool_v439_prepare_validation",
            {
              issueId: payload.issueId,
              artifactDigest: issue.artifactDigest,
              scoreBps: record.validationScoreBps,
              evidenceDigest:
                record.validationEvidenceDigest,
              validationSalt: record.validationSalt,
            },
          );
          await mcp.call(
            "agentpool_v439_commit_validation",
            {
              issueId: payload.issueId,
              validationCommitment:
                prepared.validationCommitment,
              quoteApool: String(
                record.validatorQuoteApool ??
                  config.candidateReward.validatorQuoteApool ??
                  "0.2",
              ),
            },
          );
          record.stage = "VALIDATION_COMMITTED";
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "validation-committed",
            issueId: payload.issueId,
          });
          continue;
        }
        if (
          ownValidation &&
          !ownValidation.revealed &&
          nowSeconds > issue.deadlines.commit &&
          nowSeconds <= issue.deadlines.reveal &&
          record.validationSalt
        ) {
          await mcp.call(
            "agentpool_v439_reveal_validation",
            {
              issueId: payload.issueId,
              scoreBps: record.validationScoreBps,
              evidenceDigest:
                record.validationEvidenceDigest,
              validationSalt: record.validationSalt,
            },
          );
          record.stage = "VALIDATION_REVEALED";
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "validation-revealed",
            issueId: payload.issueId,
          });
          continue;
        }
        if (nowSeconds > issue.deadlines.reveal) {
          await mcp.call(
            "agentpool_v439_finalize_candidate_reward",
            { issueId: payload.issueId },
          );
          record.stage = "FINALIZED";
          outcomes.push({
            role: "CANDIDATE_REWARD",
            status: "finalized",
            issueId: payload.issueId,
          });
        }
        continue;
      }

      if (
        ["SETTLED", "REJECTED", "EXPIRED"].includes(issue.state)
      ) {
        record.stage = issue.state;
        record.terminal = true;
        if (local.candidateRewardActiveIssueId === payload.issueId) {
          local.candidateRewardActiveIssueId = null;
        }
        outcomes.push({
          role: "CANDIDATE_REWARD",
          status: issue.state.toLowerCase(),
          issueId: payload.issueId,
        });
      }
    } catch (error) {
      outcomes.push({
        role: "CANDIDATE_REWARD",
        status: "error",
        issueId: payload.issueId,
        error:
          error instanceof Error ? error.message : String(error),
      });
    }
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
