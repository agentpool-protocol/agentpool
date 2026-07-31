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
    journal: [],
  };
}

function appendExposureJournal(ledger, action, slot) {
  const previousEntryHash =
    ledger.journal.at(-1)?.entryHash ?? `0x${"00".repeat(32)}`;
  const body = {
    schema: "agentpool.v44.exposure-journal-entry/v1",
    sequence: ledger.journal.length,
    previousEntryHash,
    action,
    slotId: slot.slotId,
    state: slot.state,
    jobId: slot.jobId,
    milestone: slot.milestone,
    terminalOutcome: slot.terminalOutcome,
  };
  ledger.journal.push({ ...body, entryHash: sha256Json(body) });
}

export function validateExposureJournal(ledger) {
  if (!Array.isArray(ledger?.journal)) {
    throw new Error("V44_EXPOSURE_JOURNAL_MISSING");
  }
  let previous = `0x${"00".repeat(32)}`;
  for (const [sequence, entry] of ledger.journal.entries()) {
    if (
      entry.sequence !== sequence ||
      entry.previousEntryHash !== previous
    ) {
      throw new Error("V44_EXPOSURE_JOURNAL_CHAIN_BROKEN");
    }
    const body = structuredClone(entry);
    delete body.entryHash;
    if (sha256Json(body) !== entry.entryHash) {
      throw new Error("V44_EXPOSURE_JOURNAL_HASH_INVALID");
    }
    previous = entry.entryHash;
  }
  return { valid: true, count: ledger.journal.length, head: previous };
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
  appendExposureJournal(ledger, "RESERVE", ledger.slots[slotId]);
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
  appendExposureJournal(ledger, "TRANSITION", slot);
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

function observerReportBody(report) {
  const body = structuredClone(report);
  delete body.reportHash;
  delete body.signature;
  return body;
}

export function observerKeyId(publicKeyPem) {
  return sha256Json({
    domain: "AGENTPOOL_V44_OBSERVER_KEY_V1",
    publicKeyPem: publicKeyPem.trim(),
  });
}

export function signObserverReport(report, privateKeyPem) {
  const body = observerReportBody(report);
  const reportHash = sha256Json(body);
  const signature = crypto
    .sign(null, Buffer.from(canonicalJson(body)), privateKeyPem)
    .toString("base64");
  return { ...body, reportHash, signature };
}

export function validateObserverReport(report, bundle) {
  const requiredHashes = [
    "evidenceHash",
    "artifactDigest",
    "environmentImageDigest",
    "roundId",
    "jobId",
    "replayDomain",
  ];
  if (report?.schema !== "agentpool.v44.shadow-report/v1") {
    throw new Error("V44_OBSERVER_REPORT_SCHEMA_INVALID");
  }
  for (const field of requiredHashes) {
    if (!HASH_PATTERN.test(report[field] ?? "")) {
      throw new Error(`V44_OBSERVER_REPORT_${field.toUpperCase()}_INVALID`);
    }
  }
  if (
    typeof report.observerPublicKeyPem !== "string" ||
    report.observerKeyId !== observerKeyId(report.observerPublicKeyPem) ||
    typeof report.controlDomain !== "string" ||
    report.controlDomain.length < 3 ||
    typeof report.signature !== "string" ||
    typeof report.pass !== "boolean" ||
    !Number.isSafeInteger(report.scoreBps) ||
    report.scoreBps < 0 ||
    report.scoreBps > 10_000 ||
    !Number.isSafeInteger(report.observedAtMs) ||
    !Number.isSafeInteger(report.milestone) ||
    report.milestone < 0
  ) {
    throw new Error("V44_OBSERVER_REPORT_FIELDS_INVALID");
  }
  const body = observerReportBody(report);
  if (
    report.reportHash !== sha256Json(body) ||
    !crypto.verify(
      null,
      Buffer.from(canonicalJson(body)),
      report.observerPublicKeyPem,
      Buffer.from(report.signature, "base64"),
    )
  ) {
    throw new Error("V44_OBSERVER_REPORT_SIGNATURE_INVALID");
  }
  for (const field of [
    "artifactDigest",
    "environmentImageDigest",
    "roundId",
    "jobId",
    "milestone",
    "replayDomain",
  ]) {
    if (report[field] !== bundle[field]) {
      throw new Error(`V44_OBSERVER_REPORT_${field.toUpperCase()}_MISMATCH`);
    }
  }
  if (report.observedAtMs > bundle.commitTimeMs) {
    throw new Error("V44_OBSERVER_REPORT_AFTER_COMMIT");
  }
  if (
    report.controlEvidence?.status !== "VERIFIED" ||
    typeof report.controlEvidence?.hostFingerprint !== "string" ||
    typeof report.controlEvidence?.controllerFingerprint !== "string"
  ) {
    throw new Error("V44_OBSERVER_CONTROL_EVIDENCE_INVALID");
  }
  return report;
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
    "sourceSnapshotDigest",
    "specificationHash",
    "testCommitment",
    "revealHash",
    "artifactDigest",
    "environmentImageDigest",
    "roundId",
    "jobId",
    "replayDomain",
    "reportRoot",
  ]) {
    if (!HASH_PATTERN.test(bundle[field] ?? "")) {
      throw new Error(`V44_SHADOW_${kind}_${field.toUpperCase()}_INVALID`);
    }
  }
  if (bundle.testCommitment === bundle.revealHash) {
    throw new Error(`V44_SHADOW_${kind}_COMMIT_REVEAL_NOT_SEPARATED`);
  }
  if (
    !Number.isSafeInteger(bundle.commitTimeMs) ||
    !Number.isSafeInteger(bundle.revealTimeMs) ||
    bundle.revealTimeMs <= bundle.commitTimeMs ||
    !Number.isSafeInteger(bundle.milestone) ||
    bundle.milestone < 0 ||
    !["EXACT_V1", "MEDIAN_V1"].includes(bundle.canonicalScorePolicyVersion)
  ) {
    throw new Error(`V44_SHADOW_${kind}_POLICY_BINDING_INVALID`);
  }
  if (!Array.isArray(bundle.reports) || bundle.reports.length < 2) {
    throw new Error(`V44_SHADOW_${kind}_REPORTS_MISSING`);
  }
  for (const report of bundle.reports) validateObserverReport(report, bundle);
  const controlGrade = gradeControlDomains(bundle.reports);
  if (
    controlGrade.verifiedReports !== bundle.reports.length ||
    controlGrade.hostDomains < 2 ||
    controlGrade.controllerDomains < 2
  ) {
    throw new Error(`V44_SHADOW_${kind}_INDEPENDENT_OBSERVERS_REQUIRED`);
  }
  deterministicValidatorScore(bundle.reports, {
    policyVersion: bundle.canonicalScorePolicyVersion,
  });
  const reportRoot = sha256Json(
    bundle.reports.map((report) => ({
      ...observerReportBody(report),
      reportHash: report.reportHash,
      signature: report.signature,
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

export function deterministicValidatorScore(
  reports,
  { policyVersion = "EXACT_V1" } = {},
) {
  if (!Array.isArray(reports) || reports.length < 2) {
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
  if (policyVersion === "EXACT_V1") {
    if (
      reports.some((report) => report.pass !== reports[0].pass) ||
      scores.some((score) => score !== scores[0])
    ) {
      throw new Error("V44_VALIDATOR_EXACT_MISMATCH");
    }
    return scores[0];
  }
  if (policyVersion !== "MEDIAN_V1") {
    throw new Error("V44_VALIDATOR_POLICY_UNSUPPORTED");
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

function governanceEventBody(event) {
  const body = structuredClone(event);
  delete body.providerIdentity;
  delete body.providerOrigin;
  return body;
}

export function reconcileGovernanceEventSets({
  providers,
  localEvents,
}) {
  if (!Array.isArray(providers) || providers.length < 2) {
    return { eligible: false, reason: "TWO_EVENT_PROVIDERS_REQUIRED" };
  }
  if (
    new Set(providers.map((provider) => provider.identity)).size < 2 ||
    new Set(providers.map((provider) => provider.origin)).size < 2
  ) {
    return { eligible: false, reason: "EVENT_PROVIDER_INDEPENDENCE_UNPROVEN" };
  }
  const normalizedSets = providers.map((provider) =>
    [...(provider.events ?? [])]
      .map((event) => ({
        ...governanceEventBody(event),
        eventHash: sha256Json(governanceEventBody(event)),
      }))
      .sort((left, right) => left.eventId.localeCompare(right.eventId)),
  );
  const canonicalRoot = sha256Json(normalizedSets[0]);
  if (normalizedSets.some((events) => sha256Json(events) !== canonicalRoot)) {
    return { eligible: false, reason: "EVENT_SET_CONFLICT" };
  }
  const canonicalIds = normalizedSets[0].map((event) => event.eventId);
  const localIds = [...(localEvents ?? [])]
    .map((event) => event.eventId)
    .sort();
  if (
    canonicalIds.length !== localIds.length ||
    canonicalIds.some((eventId, index) => eventId !== localIds[index])
  ) {
    return {
      eligible: false,
      reason: "LOCAL_EVENT_SET_INCOMPLETE",
      canonicalEventIds: canonicalIds,
      localEventIds: localIds,
    };
  }
  return {
    eligible: true,
    canonicalRoot,
    events: normalizedSets[0],
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

function checkpointBody(checkpoint) {
  const body = structuredClone(checkpoint);
  delete body.checkpointHash;
  delete body.signatures;
  return body;
}

export function signCheckpoint(
  checkpoint,
  { privateKeyPem, publicKeyPem, controllerDomain },
) {
  const body = checkpointBody(checkpoint);
  const checkpointHash = sha256Json(body);
  return {
    ...checkpoint,
    checkpointHash,
    signatures: [
      ...(checkpoint.signatures ?? []),
      {
        signerKeyId: observerKeyId(publicKeyPem),
        publicKeyPem,
        controllerDomain,
        signature: crypto
          .sign(null, Buffer.from(canonicalJson(body)), privateKeyPem)
          .toString("base64"),
      },
    ],
  };
}

export function validateCheckpointChain(
  checkpoints,
  { authorizedPublicKeys = [], threshold = 2 } = {},
) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return {
      valid: false,
      status: "PENDING_NO_CHECKPOINT",
      head: null,
      count: 0,
    };
  }
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    authorizedPublicKeys.length < threshold
  ) {
    throw new Error("V44_CHECKPOINT_SIGNER_POLICY_INVALID");
  }
  const authorizedIds = new Set(
    authorizedPublicKeys.map((publicKeyPem) => observerKeyId(publicKeyPem)),
  );
  let previous = `0x${"00".repeat(32)}`;
  for (const checkpoint of checkpoints) {
    if (checkpoint.previousCheckpointHash !== previous) {
      throw new Error("V44_CHECKPOINT_CHAIN_BROKEN");
    }
    const body = checkpointBody(checkpoint);
    if (sha256Json(body) !== checkpoint.checkpointHash) {
      throw new Error("V44_CHECKPOINT_HASH_INVALID");
    }
    const validSignatures = [];
    for (const signature of checkpoint.signatures ?? []) {
      if (
        !authorizedIds.has(signature.signerKeyId) ||
        signature.signerKeyId !== observerKeyId(signature.publicKeyPem) ||
        typeof signature.controllerDomain !== "string" ||
        !crypto.verify(
          null,
          Buffer.from(canonicalJson(body)),
          signature.publicKeyPem,
          Buffer.from(signature.signature ?? "", "base64"),
        )
      ) {
        continue;
      }
      validSignatures.push(signature);
    }
    if (
      new Set(validSignatures.map((signature) => signature.signerKeyId)).size <
        threshold ||
      new Set(
        validSignatures.map((signature) => signature.controllerDomain),
      ).size < threshold
    ) {
      throw new Error("V44_CHECKPOINT_SIGNATURE_THRESHOLD");
    }
    previous = checkpoint.checkpointHash;
  }
  return {
    valid: true,
    status: "VERIFIED",
    head: previous,
    count: checkpoints.length,
  };
}

export function validateAutonomyEvidence(evidence) {
  if (evidence?.schema !== "agentpool.v44.autonomy-evidence/v1") {
    throw new Error("V44_AUTONOMY_EVIDENCE_SCHEMA_INVALID");
  }
  const summary = exposureSummary(evidence.exposureLedger);
  const exposureJournal = validateExposureJournal(evidence.exposureLedger);
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
  const admissionBundles = evidence.admissionBundles ?? [];
  const settlementBundles = evidence.settlementBundles ?? [];
  const eventReconciliation = reconcileGovernanceEventSets({
    providers: evidence.governanceEventProviders ?? [],
    localEvents: evidence.governanceEvents ?? [],
  });
  const checkpoint = validateCheckpointChain(evidence.checkpoints ?? [], {
    authorizedPublicKeys: evidence.checkpointPolicy?.authorizedPublicKeys ?? [],
    threshold: evidence.checkpointPolicy?.threshold ?? 2,
  });
  if (
    admissionBundles.length === 0 ||
    settlementBundles.length === 0 ||
    checkpoint.valid !== true ||
    eventReconciliation.eligible !== true
  ) {
    return {
      valid: false,
      status: "PENDING_NO_EVIDENCE",
      exposure: summary,
      exposureJournal,
      checkpoint,
      eventReconciliation,
      contamination: {
        governanceContaminated: "UNVERIFIED",
        violationEventIds: [],
        finalizedEventCount: 0,
      },
    };
  }
  const contamination = reduceGovernanceContamination(
    eventReconciliation.events,
  );
  return {
    valid: contamination.governanceContaminated === false,
    status:
      contamination.governanceContaminated === false
        ? "VERIFIED"
        : "GOVERNANCE_CONTAMINATED",
    exposure: summary,
    exposureJournal,
    checkpoint,
    eventReconciliation,
    contamination,
  };
}
