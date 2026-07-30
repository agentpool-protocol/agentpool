import crypto from "node:crypto";

export const SLOT_STATES = Object.freeze({
  RESERVED_FOR_ISSUE: "RESERVED_FOR_ISSUE",
  BOUND_TO_JOB_MILESTONE: "BOUND_TO_JOB_MILESTONE",
  VALIDATION_OPEN: "VALIDATION_OPEN",
  VALIDATOR_AUTHORIZED: "VALIDATOR_AUTHORIZED",
  SUCCESSFULLY_CONSUMED: "SUCCESSFULLY_CONSUMED",
  TERMINAL_WITHOUT_SUCCESS: "TERMINAL_WITHOUT_SUCCESS",
});

const ALLOWED_SLOT_TRANSITIONS = Object.freeze({
  [SLOT_STATES.RESERVED_FOR_ISSUE]: new Set([
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  ]),
  [SLOT_STATES.BOUND_TO_JOB_MILESTONE]: new Set([
    SLOT_STATES.VALIDATION_OPEN,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  ]),
  [SLOT_STATES.VALIDATION_OPEN]: new Set([
    SLOT_STATES.VALIDATOR_AUTHORIZED,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  ]),
  [SLOT_STATES.VALIDATOR_AUTHORIZED]: new Set([
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  ]),
  [SLOT_STATES.SUCCESSFULLY_CONSUMED]: new Set(),
  [SLOT_STATES.TERMINAL_WITHOUT_SUCCESS]: new Set(),
});

const HASH_PATTERN = /^0x[0-9a-f]{64}$/u;
const TERMINAL_OUTCOMES = new Set([
  "REJECTED",
  "REFUNDED",
  "EXPIRED",
  "NO_QUORUM",
  "CANCELLED",
]);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256Json(value) {
  return `0x${crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function exposureSlotId({
  issueHash,
  candidateOperatorGroup,
  objectiveLeaf,
  candidateIndex,
}) {
  for (const [label, value] of Object.entries({
    issueHash,
    candidateOperatorGroup,
    objectiveLeaf,
  })) {
    if (!HASH_PATTERN.test(value ?? "")) {
      throw new Error(`V44_EXPOSURE_SLOT_${label.toUpperCase()}_INVALID`);
    }
  }
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
    throw new Error("V44_EXPOSURE_SLOT_CANDIDATE_INDEX_INVALID");
  }
  return sha256Json({
    domain: "AGENTPOOL_V44_EXPOSURE_SLOT_V1",
    issueHash,
    candidateOperatorGroup,
    objectiveLeaf,
    candidateIndex,
  });
}

export function newExposureLedger({ maximumSuccessfulSystemSettlements = 49 } = {}) {
  if (
    !Number.isSafeInteger(maximumSuccessfulSystemSettlements) ||
    maximumSuccessfulSystemSettlements < 0
  ) {
    throw new Error("V44_EXPOSURE_MAXIMUM_INVALID");
  }
  return {
    schema: "agentpool.v44.exposure-ledger/v1",
    maximumSuccessfulSystemSettlements,
    successfulSystemSettlements: 0,
    slots: {},
  };
}

function liveExposure(ledger) {
  return Object.values(ledger.slots).filter(
    (slot) =>
      slot.state !== SLOT_STATES.SUCCESSFULLY_CONSUMED &&
      slot.state !== SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  ).length;
}

export function reserveExposureSlot(ledger, descriptor) {
  const slotId = exposureSlotId(descriptor);
  if (ledger.slots[slotId]) {
    throw new Error("V44_EXPOSURE_SLOT_DUPLICATE");
  }
  const worstCase =
    ledger.successfulSystemSettlements + liveExposure(ledger) + 1;
  if (worstCase > ledger.maximumSuccessfulSystemSettlements) {
    throw new Error("V44_EXPOSURE_WORST_CASE_LIMIT");
  }
  ledger.slots[slotId] = {
    slotId,
    ...descriptor,
    state: SLOT_STATES.RESERVED_FOR_ISSUE,
    jobId: null,
    milestone: null,
    terminalOutcome: null,
  };
  return slotId;
}

export function transitionExposureSlot(
  ledger,
  slotId,
  nextState,
  {
    jobId = null,
    milestone = null,
    issueExpired = false,
    descendantFinalized = false,
    terminalOutcome = null,
  } = {},
) {
  const slot = ledger.slots[slotId];
  if (!slot) throw new Error("V44_EXPOSURE_SLOT_UNKNOWN");
  if (!ALLOWED_SLOT_TRANSITIONS[slot.state]?.has(nextState)) {
    throw new Error("V44_EXPOSURE_SLOT_TRANSITION_INVALID");
  }
  if (
    nextState === SLOT_STATES.BOUND_TO_JOB_MILESTONE &&
    (!HASH_PATTERN.test(jobId ?? "") ||
      !Number.isSafeInteger(milestone) ||
      milestone < 0)
  ) {
    throw new Error("V44_EXPOSURE_DESCENDANT_BINDING_INVALID");
  }
  if (nextState === SLOT_STATES.TERMINAL_WITHOUT_SUCCESS) {
    const reservedExpiry =
      slot.state === SLOT_STATES.RESERVED_FOR_ISSUE && issueExpired;
    const descendantTerminal =
      slot.state !== SLOT_STATES.RESERVED_FOR_ISSUE &&
      descendantFinalized &&
      TERMINAL_OUTCOMES.has(terminalOutcome);
    if (!reservedExpiry && !descendantTerminal) {
      throw new Error("V44_EXPOSURE_TERMINAL_NOT_FINAL");
    }
  }
  if (nextState === SLOT_STATES.SUCCESSFULLY_CONSUMED) {
    if (!descendantFinalized || terminalOutcome !== "SETTLED") {
      throw new Error("V44_EXPOSURE_SUCCESS_NOT_FINAL");
    }
    ledger.successfulSystemSettlements += 1;
  }
  slot.state = nextState;
  if (jobId) slot.jobId = jobId;
  if (milestone !== null) slot.milestone = milestone;
  if (terminalOutcome) slot.terminalOutcome = terminalOutcome;
  return slot;
}

export function exposureSummary(ledger) {
  const states = Object.fromEntries(
    Object.values(SLOT_STATES).map((state) => [state, 0]),
  );
  for (const slot of Object.values(ledger.slots)) states[slot.state] += 1;
  return {
    successfulSystemSettlements: ledger.successfulSystemSettlements,
    liveExposure: liveExposure(ledger),
    worstCaseSuccessfulSettlements:
      ledger.successfulSystemSettlements + liveExposure(ledger),
    maximumSuccessfulSystemSettlements:
      ledger.maximumSuccessfulSystemSettlements,
    states,
  };
}

export function shadowBundleHash(bundle) {
  const body = structuredClone(bundle);
  delete body.bundleHash;
  return sha256Json(body);
}

export function validateShadowBundle(bundle, { kind }) {
  const expectedSchema =
    kind === "ADMISSION"
      ? "agentpool.v44.shadow-admission/v1"
      : "agentpool.v44.shadow-settlement/v1";
  if (bundle?.schema !== expectedSchema) {
    throw new Error(`V44_SHADOW_${kind}_SCHEMA_INVALID`);
  }
  for (const field of [
    "issueHash",
    "sourceCommit",
    "specificationHash",
    "testCommitment",
    "revealHash",
    "reportRoot",
  ]) {
    if (!HASH_PATTERN.test(bundle[field] ?? "")) {
      throw new Error(`V44_SHADOW_${kind}_${field.toUpperCase()}_INVALID`);
    }
  }
  if (bundle.testCommitment === bundle.revealHash) {
    throw new Error(`V44_SHADOW_${kind}_COMMIT_REVEAL_NOT_SEPARATED`);
  }
  if (!Array.isArray(bundle.reports) || bundle.reports.length < 1) {
    throw new Error(`V44_SHADOW_${kind}_REPORTS_MISSING`);
  }
  const reportRoot = sha256Json(
    bundle.reports.map((report) => ({
      reportHash: report.reportHash,
      scoreBps: report.scoreBps,
      evidenceHash: report.evidenceHash,
      controlDomain: report.controlDomain,
    })),
  );
  if (reportRoot !== bundle.reportRoot) {
    throw new Error(`V44_SHADOW_${kind}_REPORT_ROOT_INVALID`);
  }
  if (bundle.bundleHash !== shadowBundleHash(bundle)) {
    throw new Error(`V44_SHADOW_${kind}_BUNDLE_HASH_INVALID`);
  }
  return bundle;
}

export function deterministicValidatorScore(reports) {
  if (!Array.isArray(reports) || reports.length < 3) {
    throw new Error("V44_VALIDATOR_REPORT_QUORUM");
  }
  const scores = reports
    .map((report) => report.scoreBps)
    .filter(
      (score) =>
        Number.isSafeInteger(score) && score >= 0 && score <= 10_000,
    )
    .sort((left, right) => left - right);
  if (scores.length !== reports.length) {
    throw new Error("V44_VALIDATOR_SCORE_INVALID");
  }
  return scores[Math.floor(scores.length / 2)];
}

export function gradeControlDomains(reports) {
  const verified = reports.filter(
    (report) =>
      report.controlEvidence?.status === "VERIFIED" &&
      typeof report.controlEvidence?.hostFingerprint === "string" &&
      typeof report.controlEvidence?.controllerFingerprint === "string",
  );
  const hosts = new Set(
    verified.map((report) => report.controlEvidence.hostFingerprint),
  );
  const controllers = new Set(
    verified.map(
      (report) => report.controlEvidence.controllerFingerprint,
    ),
  );
  if (verified.length !== reports.length) {
    return {
      grade: "UNVERIFIED",
      verifiedReports: verified.length,
      hostDomains: hosts.size,
      controllerDomains: controllers.size,
    };
  }
  if (hosts.size >= 3 && controllers.size >= 3) {
    return {
      grade: "INDEPENDENT",
      verifiedReports: verified.length,
      hostDomains: hosts.size,
      controllerDomains: controllers.size,
    };
  }
  return {
    grade: "OBSERVED_NOT_INDEPENDENT",
    verifiedReports: verified.length,
    hostDomains: hosts.size,
    controllerDomains: controllers.size,
  };
}

export function reconcileFinalizedProviders(
  providers,
  {
    nowMs = Date.now(),
    maximumFinalizedAgeMs = 10 * 60 * 1_000,
    maximumFinalityLagBlocks = 1_200,
  } = {},
) {
  if (!Array.isArray(providers) || providers.length < 2) {
    return { eligible: false, reason: "TWO_PROVIDERS_REQUIRED" };
  }
  const identities = new Set(providers.map((provider) => provider.identity));
  const origins = new Set(providers.map((provider) => provider.origin));
  if (identities.size < 2 || origins.size < 2) {
    return { eligible: false, reason: "PROVIDER_INDEPENDENCE_UNPROVEN" };
  }
  const [first, ...rest] = providers;
  if (
    rest.some(
      (provider) =>
        provider.finalizedBlockNumber !== first.finalizedBlockNumber ||
        provider.finalizedBlockHash !== first.finalizedBlockHash,
    )
  ) {
    return { eligible: false, reason: "FINALIZED_HEAD_CONFLICT" };
  }
  if (
    providers.some(
      (provider) =>
        nowMs - provider.finalizedTimestampMs > maximumFinalizedAgeMs,
    )
  ) {
    return { eligible: false, reason: "FINALIZED_HEAD_STALE" };
  }
  if (
    providers.some(
      (provider) =>
        provider.latestBlockNumber - provider.finalizedBlockNumber >
        maximumFinalityLagBlocks,
    )
  ) {
    return { eligible: false, reason: "FINALITY_LAG_EXCEEDED" };
  }
  return {
    eligible: true,
    finalizedBlockNumber: first.finalizedBlockNumber,
    finalizedBlockHash: first.finalizedBlockHash,
    providerCount: providers.length,
  };
}

export function reduceGovernanceContamination(events) {
  const finalizedCanonical = events
    .filter((event) => event.finalized === true && event.canonical === true)
    .sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber - right.blockNumber;
      }
      return left.logIndex - right.logIndex;
    });
  const violations = finalizedCanonical.filter(
    (event) =>
      event.type === "SYSTEM_SETTLED" &&
      !(
        event.admissionBundleValid === true &&
        event.settlementBundleValid === true &&
        event.canonicalScoreValid === true &&
        event.uniqueExposureSlotValid === true &&
        event.outcomeRecorded === true
      ),
  );
  return {
    governanceContaminated: violations.length > 0,
    violationEventIds: violations.map((event) => event.eventId),
    finalizedEventCount: finalizedCanonical.length,
  };
}

export function createCheckpoint({
  previousCheckpointHash,
  finalizedBlockNumber,
  finalizedBlockHash,
  exposureLedgerRoot,
  admissionBundleRoot,
  settlementBundleRoot,
  contaminationLatch,
  incidentRoot,
  generatedCodeCommit,
}) {
  const checkpoint = {
    schema: "agentpool.v44.readiness-checkpoint/v1",
    checkpointVersion: 1,
    previousCheckpointHash,
    finalizedBlockNumber,
    finalizedBlockHash,
    exposureLedgerRoot,
    admissionBundleRoot,
    settlementBundleRoot,
    contaminationLatch,
    incidentRoot,
    generatedCodeCommit,
  };
  return { ...checkpoint, checkpointHash: sha256Json(checkpoint) };
}

export function validateCheckpointChain(checkpoints) {
  let previous = `0x${"00".repeat(32)}`;
  for (const checkpoint of checkpoints) {
    if (checkpoint.previousCheckpointHash !== previous) {
      throw new Error("V44_CHECKPOINT_CHAIN_BROKEN");
    }
    const body = structuredClone(checkpoint);
    delete body.checkpointHash;
    if (sha256Json(body) !== checkpoint.checkpointHash) {
      throw new Error("V44_CHECKPOINT_HASH_INVALID");
    }
    previous = checkpoint.checkpointHash;
  }
  return {
    valid: true,
    head: previous,
    count: checkpoints.length,
  };
}

export function validateAutonomyEvidence(evidence) {
  if (evidence?.schema !== "agentpool.v44.autonomy-evidence/v1") {
    throw new Error("V44_AUTONOMY_EVIDENCE_SCHEMA_INVALID");
  }
  const summary = exposureSummary(evidence.exposureLedger);
  if (
    summary.worstCaseSuccessfulSettlements >
    summary.maximumSuccessfulSystemSettlements
  ) {
    throw new Error("V44_AUTONOMY_EXPOSURE_LIMIT_EXCEEDED");
  }
  for (const bundle of evidence.admissionBundles ?? []) {
    validateShadowBundle(bundle, { kind: "ADMISSION" });
  }
  for (const bundle of evidence.settlementBundles ?? []) {
    validateShadowBundle(bundle, { kind: "SETTLEMENT" });
  }
  const checkpoint = validateCheckpointChain(
    evidence.checkpoints ?? [],
  );
  const contamination = reduceGovernanceContamination(
    evidence.governanceEvents ?? [],
  );
  return {
    valid: true,
    exposure: summary,
    checkpoint,
    contamination,
  };
}
