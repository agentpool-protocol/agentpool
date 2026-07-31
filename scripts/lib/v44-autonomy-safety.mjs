import crypto from "node:crypto";
import { keccak256, toBytes } from "viem";

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
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const ZERO_HASH = `0x${"00".repeat(32)}`;
export const V44_SYSTEM_SETTLED_EVENT_SIGNATURE =
  "V44SystemSettled(bytes32,bytes32,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)";
export const V44_SYSTEM_SETTLED_TOPIC0 = keccak256(
  toBytes(V44_SYSTEM_SETTLED_EVENT_SIGNATURE),
).toLowerCase();
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

function controlDomainRegistryBody(registry) {
  const body = structuredClone(registry);
  delete body.registryHash;
  delete body.signatures;
  return body;
}

export function createControlDomainRegistry({
  entries,
  issuedAtMs,
  expiresAtMs,
}) {
  const registry = {
    schema: "agentpool.v44.control-domain-registry/v1",
    registryVersion: 1,
    issuedAtMs,
    expiresAtMs,
    entries: [...entries].sort((left, right) =>
      left.observerKeyId.localeCompare(right.observerKeyId),
    ),
  };
  return {
    ...registry,
    registryHash: sha256Json(registry),
    signatures: [],
  };
}

export function signControlDomainRegistry(
  registry,
  { privateKeyPem, publicKeyPem, controllerDomain },
) {
  const body = controlDomainRegistryBody(registry);
  return {
    ...registry,
    registryHash: sha256Json(body),
    signatures: [
      ...(registry.signatures ?? []),
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

export function validateControlDomainRegistry(
  registry,
  {
    authorizedPublicKeys = [],
    threshold = 2,
    atMs = Date.now(),
  } = {},
) {
  if (
    registry?.schema !== "agentpool.v44.control-domain-registry/v1" ||
    registry.registryVersion !== 1 ||
    !Number.isSafeInteger(registry.issuedAtMs) ||
    !Number.isSafeInteger(registry.expiresAtMs) ||
    registry.issuedAtMs > atMs ||
    registry.expiresAtMs < atMs ||
    !Array.isArray(registry.entries)
  ) {
    throw new Error("V44_CONTROL_DOMAIN_REGISTRY_INVALID");
  }
  const entriesByKey = new Map();
  for (const entry of registry.entries) {
    if (
      !HASH_PATTERN.test(entry.observerKeyId ?? "") ||
      !["CORROBORATED", "INDEPENDENT_REVIEWED"].includes(entry.status) ||
      !HASH_PATTERN.test(entry.anchorEvidenceHash ?? "") ||
      typeof entry.hostDomainId !== "string" ||
      entry.hostDomainId.length < 3 ||
      typeof entry.controllerDomainId !== "string" ||
      entry.controllerDomainId.length < 3 ||
      entriesByKey.has(entry.observerKeyId)
    ) {
      throw new Error("V44_CONTROL_DOMAIN_REGISTRY_ENTRY_INVALID");
    }
    entriesByKey.set(entry.observerKeyId, entry);
  }
  const body = controlDomainRegistryBody(registry);
  if (registry.registryHash !== sha256Json(body)) {
    throw new Error("V44_CONTROL_DOMAIN_REGISTRY_HASH_INVALID");
  }
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    authorizedPublicKeys.length < threshold
  ) {
    throw new Error("V44_CONTROL_DOMAIN_REGISTRY_POLICY_INVALID");
  }
  const authorizedIds = new Set(
    authorizedPublicKeys.map((publicKeyPem) => observerKeyId(publicKeyPem)),
  );
  const validSignatures = (registry.signatures ?? []).filter(
    (signature) =>
      authorizedIds.has(signature.signerKeyId) &&
      signature.signerKeyId === observerKeyId(signature.publicKeyPem) &&
      typeof signature.controllerDomain === "string" &&
      crypto.verify(
        null,
        Buffer.from(canonicalJson(body)),
        signature.publicKeyPem,
        Buffer.from(signature.signature ?? "", "base64"),
      ),
  );
  if (
    new Set(validSignatures.map((signature) => signature.signerKeyId)).size <
      threshold ||
    new Set(validSignatures.map((signature) => signature.controllerDomain))
      .size < threshold
  ) {
    throw new Error("V44_CONTROL_DOMAIN_REGISTRY_SIGNATURE_THRESHOLD");
  }
  return {
    valid: true,
    registryHash: registry.registryHash,
    entriesByKey,
  };
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
    "exposureSlotId",
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
    report.milestone < 0 ||
    !["ADMISSION", "SETTLEMENT"].includes(report.bundleKind) ||
    !["EXACT_V1", "MEDIAN_V1"].includes(
      report.canonicalScorePolicyVersion,
    ) ||
    !Number.isSafeInteger(report.commitTimeMs)
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
    "issueHash",
    "sourceSnapshotDigest",
    "specificationHash",
    "testCommitment",
    "revealHash",
    "artifactDigest",
    "environmentImageDigest",
    "roundId",
    "jobId",
    "milestone",
    "replayDomain",
    "exposureSlotId",
    "canonicalScorePolicyVersion",
    "commitTimeMs",
  ]) {
    if (report[field] !== bundle[field]) {
      throw new Error(`V44_OBSERVER_REPORT_${field.toUpperCase()}_MISMATCH`);
    }
  }
  if (report.observedAtMs > bundle.commitTimeMs) {
    throw new Error("V44_OBSERVER_REPORT_AFTER_COMMIT");
  }
  const expectedKind = bundle.schema.includes("admission")
    ? "ADMISSION"
    : "SETTLEMENT";
  if (report.bundleKind !== expectedKind) {
    throw new Error("V44_OBSERVER_REPORT_BUNDLE_KIND_MISMATCH");
  }
  return report;
}

export function validateShadowBundle(
  bundle,
  { kind, controlDomainRegistry },
) {
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
    "exposureSlotId",
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
  if (
    new Set(bundle.reports.map((report) => report.observerKeyId)).size !==
    bundle.reports.length
  ) {
    throw new Error(`V44_SHADOW_${kind}_OBSERVER_KEY_REUSED`);
  }
  const controlGrade = gradeControlDomains(
    bundle.reports,
    controlDomainRegistry,
  );
  if (
    bundle.reports.some(
      (report) =>
        controlDomainRegistry?.entriesByKey?.get(report.observerKeyId)
          ?.controllerDomainId !== report.controlDomain,
    )
  ) {
    throw new Error(`V44_SHADOW_${kind}_CONTROL_DOMAIN_MISMATCH`);
  }
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

export function gradeControlDomains(reports, controlDomainRegistry) {
  const registryEntries =
    controlDomainRegistry?.entriesByKey instanceof Map
      ? controlDomainRegistry.entriesByKey
      : new Map();
  const verified = reports
    .map((report) => ({
      report,
      registry: registryEntries.get(report.observerKeyId),
    }))
    .filter(
      ({ registry }) =>
        registry &&
        ["CORROBORATED", "INDEPENDENT_REVIEWED"].includes(registry.status),
    );
  const hosts = new Set(
    verified.map(({ registry }) => registry.hostDomainId),
  );
  const controllers = new Set(
    verified.map(({ registry }) => registry.controllerDomainId),
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

function hexWord(value) {
  return value.toString(16).padStart(64, "0");
}

export function encodeV44SystemSettledRawLog({
  transactionHash,
  blockHash,
  blockNumber,
  logIndex,
  address,
  transactionInput = "0x",
  issueHash,
  jobId,
  milestone,
  roundId,
  artifactDigest,
  sourceSnapshotDigest,
  specificationHash,
  admissionBundleHash,
  settlementBundleHash,
  exposureSlotId: slotId,
  outcomeEventId,
}) {
  const dataWords = [
    roundId,
    artifactDigest,
    sourceSnapshotDigest,
    specificationHash,
    admissionBundleHash,
    settlementBundleHash,
    slotId,
    outcomeEventId,
  ];
  return {
    transactionHash,
    blockHash,
    blockNumber,
    logIndex,
    address,
    receiptStatus: "success",
    transactionInput,
    topics: [
      V44_SYSTEM_SETTLED_TOPIC0,
      issueHash,
      jobId,
      `0x${hexWord(BigInt(milestone))}`,
    ],
    data: `0x${dataWords.map((value) => value.slice(2)).join("")}`,
  };
}

function decodeV44SystemSettledRawLog(rawEvent, allowedEmitters) {
  if (
    !HASH_PATTERN.test(rawEvent?.transactionHash ?? "") ||
    !HASH_PATTERN.test(rawEvent?.blockHash ?? "") ||
    !Number.isSafeInteger(rawEvent?.blockNumber) ||
    rawEvent.blockNumber < 0 ||
    !Number.isSafeInteger(rawEvent?.logIndex) ||
    rawEvent.logIndex < 0 ||
    !ADDRESS_PATTERN.test(rawEvent?.address?.toLowerCase?.() ?? "") ||
    rawEvent.receiptStatus !== "success" ||
    typeof rawEvent.transactionInput !== "string" ||
    !/^0x[0-9a-f]*$/u.test(rawEvent.transactionInput.toLowerCase()) ||
    !Array.isArray(rawEvent.topics) ||
    rawEvent.topics.length !== 4 ||
    rawEvent.topics[0]?.toLowerCase() !== V44_SYSTEM_SETTLED_TOPIC0 ||
    !HASH_PATTERN.test(rawEvent.topics[1] ?? "") ||
    !HASH_PATTERN.test(rawEvent.topics[2] ?? "") ||
    !HASH_PATTERN.test(rawEvent.topics[3] ?? "") ||
    typeof rawEvent.data !== "string" ||
    !/^0x[0-9a-f]{512}$/u.test(rawEvent.data.toLowerCase())
  ) {
    throw new Error("V44_GOVERNANCE_RAW_LOG_INVALID");
  }
  if (!allowedEmitters.has(rawEvent.address.toLowerCase())) {
    throw new Error("V44_GOVERNANCE_EVENT_EMITTER_UNAUTHORIZED");
  }
  const dataWords = rawEvent.data
    .slice(2)
    .match(/.{64}/gu)
    .map((word) => `0x${word.toLowerCase()}`);
  const milestoneBigInt = BigInt(rawEvent.topics[3]);
  if (milestoneBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("V44_GOVERNANCE_MILESTONE_INVALID");
  }
  return {
    eventId: `${rawEvent.transactionHash.toLowerCase()}:${rawEvent.logIndex}`,
    type: "SYSTEM_SETTLED",
    transactionHash: rawEvent.transactionHash.toLowerCase(),
    blockHash: rawEvent.blockHash.toLowerCase(),
    blockNumber: rawEvent.blockNumber,
    logIndex: rawEvent.logIndex,
    emitter: rawEvent.address.toLowerCase(),
    transactionInputHash: sha256Json({
      transactionInput: rawEvent.transactionInput.toLowerCase(),
    }),
    issueHash: rawEvent.topics[1].toLowerCase(),
    jobId: rawEvent.topics[2].toLowerCase(),
    milestone: Number(milestoneBigInt),
    roundId: dataWords[0],
    artifactDigest: dataWords[1],
    sourceSnapshotDigest: dataWords[2],
    specificationHash: dataWords[3],
    admissionBundleHash: dataWords[4],
    settlementBundleHash: dataWords[5],
    exposureSlotId: dataWords[6],
    outcomeEventId: dataWords[7],
    finalized: true,
    canonical: true,
  };
}

async function rpcRequest(rpcUrl, method, params, fetcher) {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(`V44_GOVERNANCE_RPC_${method}_FAILED`);
  }
  return payload.result;
}

function rpcQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export async function collectGovernanceEventSnapshot({
  rpcUrl,
  fromBlock,
  allowedEmitters,
  finalizedBlockNumber,
  fetcher = fetch,
}) {
  if (
    typeof rpcUrl !== "string" ||
    !Number.isSafeInteger(fromBlock) ||
    fromBlock < 0 ||
    !Array.isArray(allowedEmitters) ||
    allowedEmitters.length === 0 ||
    allowedEmitters.some(
      (address) => !ADDRESS_PATTERN.test(address.toLowerCase()),
    )
  ) {
    throw new Error("V44_GOVERNANCE_RPC_POLICY_INVALID");
  }
  const chainId = Number(
    BigInt(await rpcRequest(rpcUrl, "eth_chainId", [], fetcher)),
  );
  if (chainId !== 84532) {
    throw new Error("V44_GOVERNANCE_RPC_CHAIN_INVALID");
  }
  const blockTag =
    finalizedBlockNumber === undefined
      ? "finalized"
      : rpcQuantity(finalizedBlockNumber);
  const finalizedBlock = await rpcRequest(
    rpcUrl,
    "eth_getBlockByNumber",
    [blockTag, false],
    fetcher,
  );
  if (
    !finalizedBlock ||
    !HASH_PATTERN.test(finalizedBlock.hash ?? "") ||
    !finalizedBlock.number
  ) {
    throw new Error("V44_GOVERNANCE_FINALIZED_BLOCK_INVALID");
  }
  const resolvedFinalizedBlockNumber = Number(BigInt(finalizedBlock.number));
  if (
    finalizedBlockNumber !== undefined &&
    resolvedFinalizedBlockNumber !== finalizedBlockNumber
  ) {
    throw new Error("V44_GOVERNANCE_FINALIZED_BLOCK_NUMBER_MISMATCH");
  }
  const logs = await rpcRequest(
    rpcUrl,
    "eth_getLogs",
    [
      {
        address: allowedEmitters,
        fromBlock: rpcQuantity(fromBlock),
        toBlock: rpcQuantity(resolvedFinalizedBlockNumber),
        topics: [V44_SYSTEM_SETTLED_TOPIC0],
      },
    ],
    fetcher,
  );
  const rawEvents = [];
  for (const log of logs) {
    const [receipt, transaction] = await Promise.all([
      rpcRequest(
        rpcUrl,
        "eth_getTransactionReceipt",
        [log.transactionHash],
        fetcher,
      ),
      rpcRequest(
        rpcUrl,
        "eth_getTransactionByHash",
        [log.transactionHash],
        fetcher,
      ),
    ]);
    rawEvents.push({
      transactionHash: log.transactionHash?.toLowerCase(),
      blockHash: log.blockHash?.toLowerCase(),
      blockNumber: Number(BigInt(log.blockNumber)),
      logIndex: Number(BigInt(log.logIndex)),
      address: log.address?.toLowerCase(),
      receiptStatus: receipt?.status === "0x1" ? "success" : "reverted",
      transactionInput: transaction?.input?.toLowerCase() ?? null,
      topics: (log.topics ?? []).map((topic) => topic.toLowerCase()),
      data: log.data?.toLowerCase(),
    });
  }
  const origin = new URL(rpcUrl).origin;
  return {
    identity: sha256Json({
      domain: "AGENTPOOL_V44_RPC_PROVIDER_V1",
      origin,
    }),
    origin,
    finalizedBlockNumber: resolvedFinalizedBlockNumber,
    finalizedBlockHash: finalizedBlock.hash.toLowerCase(),
    rawEvents,
  };
}

export function reconcileGovernanceEventSets({
  providers,
  localEventIds,
  allowedEmitters = [],
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
  const first = providers[0];
  if (
    !Number.isSafeInteger(first.finalizedBlockNumber) ||
    !HASH_PATTERN.test(first.finalizedBlockHash ?? "") ||
    providers.some(
      (provider) =>
        provider.finalizedBlockNumber !== first.finalizedBlockNumber ||
        provider.finalizedBlockHash?.toLowerCase() !==
          first.finalizedBlockHash.toLowerCase(),
    )
  ) {
    return { eligible: false, reason: "EVENT_PROVIDER_FINALIZED_HEAD_CONFLICT" };
  }
  const emitterSet = new Set(
    allowedEmitters.map((address) => address.toLowerCase()),
  );
  if (
    emitterSet.size === 0 ||
    [...emitterSet].some((address) => !ADDRESS_PATTERN.test(address))
  ) {
    return { eligible: false, reason: "EVENT_EMITTER_POLICY_MISSING" };
  }
  const normalizedSets = providers.map((provider) =>
    [...(provider.rawEvents ?? [])]
      .map((rawEvent) => decodeV44SystemSettledRawLog(rawEvent, emitterSet))
      .filter((event) => event.blockNumber <= provider.finalizedBlockNumber)
      .map((event) => ({ ...event, eventHash: sha256Json(event) }))
      .sort((left, right) => left.eventId.localeCompare(right.eventId)),
  );
  const canonicalRoot = sha256Json(normalizedSets[0]);
  if (normalizedSets.some((events) => sha256Json(events) !== canonicalRoot)) {
    return { eligible: false, reason: "EVENT_SET_CONFLICT" };
  }
  const canonicalIds = normalizedSets[0].map((event) => event.eventId);
  const localIds = [...(localEventIds ?? [])].sort();
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
    finalizedBlockNumber: first.finalizedBlockNumber,
    finalizedBlockHash: first.finalizedBlockHash.toLowerCase(),
  };
}

function bundleRoot(bundles) {
  return sha256Json(
    [...bundles]
      .map((bundle) => bundle.bundleHash)
      .sort((left, right) => left.localeCompare(right)),
  );
}

function incidentRoot(incidents) {
  return sha256Json(
    [...incidents]
      .map((incident) => sha256Json(incident))
      .sort((left, right) => left.localeCompare(right)),
  );
}

function eventJoinKey(value) {
  return canonicalJson({
    issueHash: value.issueHash,
    jobId: value.jobId,
    milestone: value.milestone,
    roundId: value.roundId,
    artifactDigest: value.artifactDigest,
    sourceSnapshotDigest: value.sourceSnapshotDigest,
    specificationHash: value.specificationHash,
  });
}

export function deriveSystemSettlementEvidence({
  events,
  admissionBundles,
  settlementBundles,
  exposureLedger,
}) {
  const allBundles = [...admissionBundles, ...settlementBundles];
  if (
    new Set(allBundles.map((bundle) => bundle.bundleHash)).size !==
      allBundles.length ||
    new Set(allBundles.map((bundle) => bundle.replayDomain)).size !==
      allBundles.length
  ) {
    throw new Error("V44_AUTONOMY_BUNDLE_REPLAY_OR_HASH_REUSED");
  }
  const admissions = new Map(
    admissionBundles.map((bundle) => [eventJoinKey(bundle), bundle]),
  );
  const settlements = new Map(
    settlementBundles.map((bundle) => [eventJoinKey(bundle), bundle]),
  );
  if (
    admissions.size !== admissionBundles.length ||
    settlements.size !== settlementBundles.length
  ) {
    throw new Error("V44_AUTONOMY_BUNDLE_JOIN_DUPLICATE");
  }
  const usedAdmissions = new Set();
  const usedSettlements = new Set();
  const usedSlots = new Set();
  const usedOutcomes = new Set();
  const derivedEvents = events.map((event) => {
    const key = eventJoinKey(event);
    const admission = admissions.get(key);
    const settlement = settlements.get(key);
    const slot = exposureLedger.slots?.[event.exposureSlotId];
    const admissionBundleValid =
      admission?.bundleHash === event.admissionBundleHash;
    const settlementBundleValid =
      settlement?.bundleHash === event.settlementBundleHash;
    const canonicalScoreValid =
      admission?.canonicalScorePolicyVersion ===
        settlement?.canonicalScorePolicyVersion &&
      admission?.reports?.[0]?.pass === settlement?.reports?.[0]?.pass &&
      admission !== undefined &&
      settlement !== undefined &&
      deterministicValidatorScore(admission.reports, {
        policyVersion: admission.canonicalScorePolicyVersion,
      }) ===
        deterministicValidatorScore(settlement.reports, {
          policyVersion: settlement.canonicalScorePolicyVersion,
        });
    const uniqueExposureSlotValid =
      slot?.issueHash === event.issueHash &&
      slot?.jobId === event.jobId &&
      slot?.milestone === event.milestone &&
      slot?.state === SLOT_STATES.SUCCESSFULLY_CONSUMED &&
      !usedSlots.has(event.exposureSlotId);
    const outcomeRecorded =
      HASH_PATTERN.test(event.outcomeEventId ?? "") &&
      event.outcomeEventId !== ZERO_HASH &&
      !usedOutcomes.has(event.outcomeEventId);
    if (admissionBundleValid) usedAdmissions.add(admission.bundleHash);
    if (settlementBundleValid) usedSettlements.add(settlement.bundleHash);
    if (uniqueExposureSlotValid) usedSlots.add(event.exposureSlotId);
    if (outcomeRecorded) usedOutcomes.add(event.outcomeEventId);
    return {
      ...event,
      admissionBundleValid,
      settlementBundleValid,
      canonicalScoreValid,
      uniqueExposureSlotValid,
      outcomeRecorded,
    };
  });
  const complete =
    derivedEvents.length === admissionBundles.length &&
    derivedEvents.length === settlementBundles.length &&
    usedAdmissions.size === admissionBundles.length &&
    usedSettlements.size === settlementBundles.length &&
    derivedEvents.every(
      (event) =>
        event.admissionBundleValid &&
        event.settlementBundleValid &&
        event.canonicalScoreValid &&
        event.uniqueExposureSlotValid &&
        event.outcomeRecorded,
    );
  return {
    complete,
    events: derivedEvents,
    admissionCount: usedAdmissions.size,
    settlementCount: usedSettlements.size,
    exposureCount: usedSlots.size,
    outcomeCount: usedOutcomes.size,
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
  {
    authorizedPublicKeys = [],
    threshold = 2,
    expectedFinalState = null,
  } = {},
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
  const finalCheckpoint = checkpoints.at(-1);
  if (
    expectedFinalState &&
    Object.entries(expectedFinalState).some(
      ([field, value]) => finalCheckpoint[field] !== value,
    )
  ) {
    throw new Error("V44_CHECKPOINT_FINAL_STATE_MISMATCH");
  }
  return {
    valid: true,
    status: "VERIFIED",
    head: previous,
    count: checkpoints.length,
  };
}

export function validateAutonomyEvidence(
  evidence,
  {
    controlDomainPolicy = null,
    checkpointPolicy = null,
    governanceEventPolicy = null,
    generatedCodeCommit = null,
    evaluationTimeMs = Date.now(),
  } = {},
) {
  if (evidence?.schema !== "agentpool.v44.autonomy-evidence/v1") {
    throw new Error("V44_AUTONOMY_EVIDENCE_SCHEMA_INVALID");
  }
  if (!Number.isSafeInteger(evaluationTimeMs) || evaluationTimeMs < 0) {
    throw new Error("V44_AUTONOMY_EVALUATION_TIME_INVALID");
  }
  const summary = exposureSummary(evidence.exposureLedger);
  const exposureJournal = validateExposureJournal(evidence.exposureLedger);
  if (
    summary.worstCaseSuccessfulSettlements >
    summary.maximumSuccessfulSystemSettlements
  ) {
    throw new Error("V44_AUTONOMY_EXPOSURE_LIMIT_EXCEEDED");
  }
  const admissionBundles = evidence.admissionBundles ?? [];
  const settlementBundles = evidence.settlementBundles ?? [];
  let controlDomainRegistry = null;
  if (admissionBundles.length > 0 || settlementBundles.length > 0) {
    controlDomainRegistry = validateControlDomainRegistry(
      evidence.controlDomainRegistry,
      {
        authorizedPublicKeys:
          controlDomainPolicy?.authorizedPublicKeys ?? [],
        threshold: controlDomainPolicy?.threshold ?? 2,
        atMs: evaluationTimeMs,
      },
    );
  }
  for (const bundle of admissionBundles) {
    validateShadowBundle(bundle, {
      kind: "ADMISSION",
      controlDomainRegistry,
    });
  }
  for (const bundle of settlementBundles) {
    validateShadowBundle(bundle, {
      kind: "SETTLEMENT",
      controlDomainRegistry,
    });
  }
  const eventReconciliation = reconcileGovernanceEventSets({
    providers: evidence.governanceEventProviders ?? [],
    localEventIds: evidence.governanceEventIds ?? [],
    allowedEmitters: governanceEventPolicy?.allowedEmitters ?? [],
  });
  if (
    admissionBundles.length === 0 ||
    settlementBundles.length === 0 ||
    eventReconciliation.eligible !== true
  ) {
    const checkpoint = validateCheckpointChain(evidence.checkpoints ?? [], {
      authorizedPublicKeys:
        checkpointPolicy?.authorizedPublicKeys ?? [],
      threshold: checkpointPolicy?.threshold ?? 2,
    });
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
  const settlementEvidence = deriveSystemSettlementEvidence({
    events: eventReconciliation.events,
    admissionBundles,
    settlementBundles,
    exposureLedger: evidence.exposureLedger,
  });
  const contamination = reduceGovernanceContamination(
    settlementEvidence.events,
  );
  const expectedFinalState = {
    finalizedBlockNumber: eventReconciliation.finalizedBlockNumber,
    finalizedBlockHash: eventReconciliation.finalizedBlockHash,
    exposureLedgerRoot: sha256Json(evidence.exposureLedger),
    admissionBundleRoot: bundleRoot(admissionBundles),
    settlementBundleRoot: bundleRoot(settlementBundles),
    contaminationLatch:
      contamination.governanceContaminated || !settlementEvidence.complete,
    incidentRoot: incidentRoot(evidence.incidents ?? []),
  };
  if (generatedCodeCommit) {
    expectedFinalState.generatedCodeCommit = generatedCodeCommit;
  }
  const checkpoint = validateCheckpointChain(evidence.checkpoints ?? [], {
    authorizedPublicKeys:
      checkpointPolicy?.authorizedPublicKeys ?? [],
    threshold: checkpointPolicy?.threshold ?? 2,
    expectedFinalState,
  });
  if (checkpoint.valid !== true) {
    return {
      valid: false,
      status: "PENDING_NO_EVIDENCE",
      exposure: summary,
      exposureJournal,
      checkpoint,
      eventReconciliation,
      settlementEvidence,
      contamination: {
        governanceContaminated: "UNVERIFIED",
        violationEventIds: [],
        finalizedEventCount: 0,
      },
    };
  }
  const verified =
    settlementEvidence.complete &&
    contamination.governanceContaminated === false;
  return {
    valid: verified,
    status:
      verified
        ? "VERIFIED"
        : "GOVERNANCE_CONTAMINATED",
    exposure: summary,
    exposureJournal,
    checkpoint,
    eventReconciliation,
    settlementEvidence,
    contamination,
  };
}
