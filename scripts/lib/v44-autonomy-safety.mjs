import crypto from "node:crypto";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  toBytes,
} from "viem";

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
export const PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS = 49;
export const V44_CHAIN_EVENT_SIGNATURES = Object.freeze({
  jobCreated:
    "JobCreated(bytes32,address,uint8,uint256,bytes32,bytes32,bytes32)",
  milestoneDelivered: "MilestoneDelivered(bytes32,uint32,bytes32,bytes32)",
  milestoneSettled: "MilestoneSettled(bytes32,uint32,uint256,address)",
  outcomeRecorded: "OutcomeRecorded(address,address,bytes32,uint256,bool)",
});

const JOB_CREATED_EVENT = {
  type: "event",
  name: "JobCreated",
  inputs: [
    { name: "jobId", type: "bytes32", indexed: true },
    { name: "creator", type: "address", indexed: true },
    { name: "funding", type: "uint8", indexed: false },
    { name: "budget", type: "uint256", indexed: false },
    { name: "releaseId", type: "bytes32", indexed: false },
    { name: "planHash", type: "bytes32", indexed: false },
    { name: "issueId", type: "bytes32", indexed: false },
  ],
};
const MILESTONE_DELIVERED_EVENT = {
  type: "event",
  name: "MilestoneDelivered",
  inputs: [
    { name: "jobId", type: "bytes32", indexed: true },
    { name: "milestone", type: "uint32", indexed: true },
    { name: "deliveryHash", type: "bytes32", indexed: false },
    { name: "proofRoundId", type: "bytes32", indexed: false },
  ],
};
const MILESTONE_SETTLED_EVENT = {
  type: "event",
  name: "MilestoneSettled",
  inputs: [
    { name: "jobId", type: "bytes32", indexed: true },
    { name: "milestone", type: "uint32", indexed: true },
    { name: "paid", type: "uint256", indexed: false },
    { name: "keeper", type: "address", indexed: true },
  ],
};
const OUTCOME_RECORDED_EVENT = {
  type: "event",
  name: "OutcomeRecorded",
  inputs: [
    { name: "source", type: "address", indexed: true },
    { name: "agent", type: "address", indexed: true },
    { name: "receiptId", type: "bytes32", indexed: true },
    { name: "units", type: "uint256", indexed: false },
    { name: "successful", type: "bool", indexed: false },
  ],
};
const CHAIN_EVENT_DEFINITIONS = Object.freeze([
  {
    type: "JOB_CREATED",
    signature: V44_CHAIN_EVENT_SIGNATURES.jobCreated,
    abi: JOB_CREATED_EVENT,
    contractKey: "taskMarket",
  },
  {
    type: "MILESTONE_DELIVERED",
    signature: V44_CHAIN_EVENT_SIGNATURES.milestoneDelivered,
    abi: MILESTONE_DELIVERED_EVENT,
    contractKey: "taskMarket",
  },
  {
    type: "MILESTONE_SETTLED",
    signature: V44_CHAIN_EVENT_SIGNATURES.milestoneSettled,
    abi: MILESTONE_SETTLED_EVENT,
    contractKey: "taskMarket",
  },
  {
    type: "OUTCOME_RECORDED",
    signature: V44_CHAIN_EVENT_SIGNATURES.outcomeRecorded,
    abi: OUTCOME_RECORDED_EVENT,
    contractKey: "contributionLedger",
  },
].map((definition) => ({
  ...definition,
  topic0: keccak256(toBytes(definition.signature)).toLowerCase(),
})));
const CHAIN_EVENT_BY_TOPIC = new Map(
  CHAIN_EVENT_DEFINITIONS.map((definition) => [definition.topic0, definition]),
);

const RESOLVE_ABI = {
  type: "function",
  name: "resolve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "jobId", type: "bytes32" },
    { name: "milestoneIndex", type: "uint32" },
    { name: "proof", type: "bytes" },
    { name: "recipients", type: "address[]" },
    { name: "amounts", type: "uint256[]" },
  ],
  outputs: [],
};
const TASK_MARKET_READ_ABI = [
  {
    type: "function",
    name: "jobs",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "funding", type: "uint8" },
      { name: "state", type: "uint8" },
      { name: "planHash", type: "bytes32" },
      { name: "releaseId", type: "bytes32" },
      { name: "issueId", type: "bytes32" },
      { name: "budget", type: "uint128" },
      { name: "paid", type: "uint128" },
      { name: "nextMilestone", type: "uint32" },
      { name: "milestoneCount", type: "uint32" },
      { name: "createdAt", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "milestones",
    stateMutability: "view",
    inputs: [
      { name: "jobId", type: "bytes32" },
      { name: "milestone", type: "uint32" },
    ],
    outputs: [
      { name: "worker", type: "address" },
      { name: "verifier", type: "address" },
      { name: "capability", type: "bytes32" },
      { name: "specificationHash", type: "bytes32" },
      { name: "expectedEvidenceHash", type: "bytes32" },
      { name: "payoutRoot", type: "bytes32" },
      { name: "deliveryHash", type: "bytes32" },
      { name: "allocation", type: "uint128" },
      { name: "workerBond", type: "uint128" },
      { name: "keeperFee", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "capacityUnits", type: "uint32" },
      { name: "minimumReveals", type: "uint16" },
      { name: "passScoreBps", type: "uint16" },
      { name: "commitWindow", type: "uint32" },
      { name: "revealWindow", type: "uint32" },
      { name: "state", type: "uint8" },
      { name: "candidateAttested", type: "bool" },
      { name: "adoptionRecorded", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "jobGovernanceEligible",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [{ name: "eligible", type: "bool" }],
  },
];
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

export function newExposureLedger() {
  return {
    schema: "agentpool.v44.exposure-ledger/v1",
    maximumSuccessfulSystemSettlements:
      PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
    successfulSystemSettlements: 0,
    maturityAuthorizationId: null,
    maturityAuthorizationConsumed: false,
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

export function reserveExposureSlot(
  ledger,
  descriptor,
  {
    maturityAuthorization = null,
    maturityAuthorizationPolicy = null,
    evaluationTimeMs = Date.now(),
  } = {},
) {
  const slotId = exposureSlotId(descriptor);
  if (ledger.slots[slotId]) {
    throw new Error("V44_EXPOSURE_SLOT_DUPLICATE");
  }
  const worstCase =
    ledger.successfulSystemSettlements + liveExposure(ledger) + 1;
  if (worstCase > ledger.maximumSuccessfulSystemSettlements) {
    if (
      worstCase !== ledger.maximumSuccessfulSystemSettlements + 1 ||
      ledger.maturityAuthorizationConsumed === true ||
      maturityAuthorizationPolicy === null
    ) {
      throw new Error("V44_EXPOSURE_WORST_CASE_LIMIT");
    }
    const verified = validateMaturityAuthorization(maturityAuthorization, {
      ...maturityAuthorizationPolicy,
      atMs: evaluationTimeMs,
      expectedExposureSlotId: slotId,
      preMatureMaximumSuccessfulSystemSettlements:
        ledger.maximumSuccessfulSystemSettlements,
    });
    ledger.maturityAuthorizationId = verified.authorizationId;
    ledger.maturityAuthorizationConsumed = true;
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

function maturityAuthorizationBody(authorization) {
  const body = structuredClone(authorization);
  delete body.authorizationId;
  delete body.signatures;
  return body;
}

export function createMaturityAuthorization({
  issuedAtMs,
  expiresAtMs,
  sourceCommit,
  deploymentManifestSha256,
  authorizedExposureSlotId,
  providerSnapshots,
}) {
  const body = {
    schema: "agentpool.v44.maturity-authorization/v1",
    authorizationVersion: 1,
    authorizationScope: "SINGLE_50TH_SYSTEM_SETTLEMENT",
    issuedAtMs,
    expiresAtMs,
    sourceCommit,
    deploymentManifestSha256,
    authorizedExposureSlotId,
    providerSnapshots,
  };
  return { ...body, authorizationId: sha256Json(body), signatures: [] };
}

export function signMaturityAuthorization(
  authorization,
  { privateKeyPem, publicKeyPem, controllerDomain },
) {
  const body = maturityAuthorizationBody(authorization);
  return {
    ...authorization,
    authorizationId: sha256Json(body),
    signatures: [
      ...(authorization.signatures ?? []),
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

export function validateMaturityAuthorization(
  authorization,
  {
    authorizedPublicKeys = [],
    threshold = 2,
    atMs = Date.now(),
    expectedSourceCommit = null,
    expectedDeploymentManifestSha256 = null,
    expectedExposureSlotId = null,
    trustedProviderSnapshots = null,
    preMatureMaximumSuccessfulSystemSettlements =
      PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
    minimumNonMaintainerVotingAgents = 5,
    minimumOnchainGroups = 3,
    minimumCorroboratedControlDomains = 3,
    maximumControlDomainShareBps = 2_999,
  } = {},
) {
  const body = maturityAuthorizationBody(authorization ?? {});
  if (
    authorization?.schema !== "agentpool.v44.maturity-authorization/v1" ||
    authorization.authorizationVersion !== 1 ||
    authorization.authorizationScope !== "SINGLE_50TH_SYSTEM_SETTLEMENT" ||
    !Number.isSafeInteger(authorization.issuedAtMs) ||
    !Number.isSafeInteger(authorization.expiresAtMs) ||
    authorization.issuedAtMs > atMs ||
    authorization.expiresAtMs < atMs ||
    !/^[0-9a-f]{40}$/u.test(authorization.sourceCommit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(
      authorization.deploymentManifestSha256 ?? "",
    ) ||
    !HASH_PATTERN.test(authorization.authorizedExposureSlotId ?? "") ||
    authorization.authorizationId !== sha256Json(body) ||
    (expectedSourceCommit !== null &&
      authorization.sourceCommit !== expectedSourceCommit) ||
    (expectedDeploymentManifestSha256 !== null &&
      authorization.deploymentManifestSha256 !==
        expectedDeploymentManifestSha256) ||
    (expectedExposureSlotId !== null &&
      authorization.authorizedExposureSlotId !== expectedExposureSlotId)
  ) {
    throw new Error("V44_MATURITY_AUTHORIZATION_IDENTITY_INVALID");
  }
  if (
    !Array.isArray(authorization.providerSnapshots) ||
    authorization.providerSnapshots.length < 2 ||
    new Set(
      authorization.providerSnapshots.map((snapshot) => snapshot.identity),
    ).size < 2 ||
    new Set(
      authorization.providerSnapshots.map((snapshot) => snapshot.origin),
    ).size < 2
  ) {
    throw new Error("V44_MATURITY_PROVIDER_INDEPENDENCE_INVALID");
  }
  const firstProvider = authorization.providerSnapshots[0];
  const snapshotRoot = sha256Json(firstProvider.snapshot);
  if (
    !Number.isSafeInteger(firstProvider.finalizedBlockNumber) ||
    !HASH_PATTERN.test(firstProvider.finalizedBlockHash ?? "") ||
    authorization.providerSnapshots.some(
      (provider) =>
        provider.finalizedBlockNumber !== firstProvider.finalizedBlockNumber ||
        provider.finalizedBlockHash?.toLowerCase() !==
          firstProvider.finalizedBlockHash.toLowerCase() ||
        sha256Json(provider.snapshot) !== snapshotRoot,
    )
  ) {
    throw new Error("V44_MATURITY_PROVIDER_SNAPSHOT_CONFLICT");
  }
  if (
    !Array.isArray(trustedProviderSnapshots) ||
    trustedProviderSnapshots.length < 2
  ) {
    throw new Error("V44_MATURITY_TRUSTED_CHAIN_SNAPSHOT_REQUIRED");
  }
  const trustedByOrigin = new Map(
    trustedProviderSnapshots.map((provider) => [provider.origin, provider]),
  );
  for (const provider of authorization.providerSnapshots) {
    const trusted = trustedByOrigin.get(provider.origin);
    if (
      trusted?.identity !== provider.identity ||
      trusted.finalizedBlockNumber !== provider.finalizedBlockNumber ||
      trusted.finalizedBlockHash?.toLowerCase() !==
        provider.finalizedBlockHash?.toLowerCase() ||
      sha256Json(trusted.chainSnapshot) !== sha256Json(provider.chainSnapshot)
    ) {
      throw new Error("V44_MATURITY_CHAIN_SNAPSHOT_NOT_CORROBORATED");
    }
  }
  const snapshot = firstProvider.snapshot;
  const agents = snapshot?.nonMaintainerVotingAgents;
  if (
    !Array.isArray(agents) ||
    agents.length < minimumNonMaintainerVotingAgents ||
    new Set(agents.map((agent) => agent.agent?.toLowerCase())).size !==
      agents.length ||
    new Set(agents.map((agent) => agent.operatorGroup)).size <
      minimumOnchainGroups ||
    new Set(agents.map((agent) => agent.controlDomain)).size <
      minimumCorroboratedControlDomains ||
    agents.some(
      (agent) =>
        !ADDRESS_PATTERN.test(agent.agent?.toLowerCase?.() ?? "") ||
        !HASH_PATTERN.test(agent.operatorGroup ?? "") ||
        typeof agent.controlDomain !== "string" ||
        agent.controlDomain.length < 3 ||
        BigInt(agent.workPower ?? 0) <= 0n,
    ) ||
    BigInt(snapshot.maintainerGovernanceUnits ?? -1) !== 0n ||
    snapshot.proposalBondAvailable !== true ||
    snapshot.recoveryIssueAvailable !== true ||
    snapshot.recoveryJobAvailable !== true ||
    snapshot.governanceDryRunPassed !== true ||
    snapshot.unresolvedCriticalHigh !== 0 ||
    snapshot.successfulSystemSettlements !==
      preMatureMaximumSuccessfulSystemSettlements
  ) {
    throw new Error("V44_MATURITY_CHAIN_REQUIREMENTS_INVALID");
  }
  const chainSnapshot = firstProvider.chainSnapshot;
  if (
    chainSnapshot?.successfulSystemSettlements !==
      snapshot.successfulSystemSettlements ||
    chainSnapshot?.eligibleAgentCount < minimumNonMaintainerVotingAgents ||
    chainSnapshot?.eligibleGroupCount < minimumOnchainGroups ||
    sha256Json(chainSnapshot?.votingAgents ?? null) !==
      sha256Json(
        agents
          .map(({ agent, operatorGroup, workPower }) => ({
            agent: agent.toLowerCase(),
            operatorGroup,
            workPower: String(workPower),
          }))
          .sort((left, right) => left.agent.localeCompare(right.agent)),
      )
  ) {
    throw new Error("V44_MATURITY_CHAIN_METRICS_MISMATCH");
  }
  const totalWorkPower = agents.reduce(
    (total, agent) => total + BigInt(agent.workPower),
    0n,
  );
  const domainPower = new Map();
  for (const agent of agents) {
    domainPower.set(
      agent.controlDomain,
      (domainPower.get(agent.controlDomain) ?? 0n) + BigInt(agent.workPower),
    );
  }
  const maximumDomainPower = [...domainPower.values()].reduce(
    (maximum, value) => (value > maximum ? value : maximum),
    0n,
  );
  if (
    totalWorkPower <= 0n ||
    maximumDomainPower * 10_000n >=
      totalWorkPower * BigInt(maximumControlDomainShareBps + 1)
  ) {
    throw new Error("V44_MATURITY_CONTROL_DOMAIN_SHARE_INVALID");
  }
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 2 ||
    authorizedPublicKeys.length < threshold
  ) {
    throw new Error("V44_MATURITY_SIGNER_POLICY_INVALID");
  }
  const authorizedIds = new Set(
    authorizedPublicKeys.map((publicKeyPem) => observerKeyId(publicKeyPem)),
  );
  const validSignatures = (authorization.signatures ?? []).filter(
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
    throw new Error("V44_MATURITY_SIGNATURE_THRESHOLD");
  }
  return {
    valid: true,
    authorizationId: authorization.authorizationId,
    finalizedBlockNumber: firstProvider.finalizedBlockNumber,
    finalizedBlockHash: firstProvider.finalizedBlockHash.toLowerCase(),
    snapshotRoot,
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

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]),
    );
  }
  return value;
}

function encodeRawEvent({
  abi,
  eventName,
  args,
  transactionHash,
  blockHash,
  blockNumber,
  logIndex,
  address,
  transactionInput = "0x",
}) {
  const nonIndexed = abi.inputs.filter((input) => input.indexed !== true);
  return {
    transactionHash: transactionHash.toLowerCase(),
    blockHash: blockHash.toLowerCase(),
    blockNumber,
    logIndex,
    address: address.toLowerCase(),
    receiptStatus: "success",
    transactionInput: transactionInput.toLowerCase(),
    topics: encodeEventTopics({ abi: [abi], eventName, args }).map((topic) =>
      topic.toLowerCase(),
    ),
    data: encodeAbiParameters(
      nonIndexed,
      nonIndexed.map((input) => args[input.name]),
    ).toLowerCase(),
  };
}

export function systemSettlementReceiptId(jobId, milestone) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
      ["AGENTPOOL_V432_SETTLEMENT", jobId, milestone],
    ),
  ).toLowerCase();
}

export function encodeV44SettlementLifecycleRawLogs({
  transactionHash,
  jobTransactionHash = `0x${"91".repeat(32)}`,
  deliveryTransactionHash = `0x${"92".repeat(32)}`,
  blockHash,
  blockNumber,
  taskMarket,
  contributionLedger,
  settlementRouter,
  issueHash,
  jobId,
  milestone,
  roundId,
  artifactDigest,
  specificationHash,
  worker = `0x${"44".repeat(20)}`,
  keeper = `0x${"55".repeat(20)}`,
  creator = `0x${"66".repeat(20)}`,
  capability = `0x${"77".repeat(32)}`,
  funding = 2,
  paid = 100n,
  units = 1n,
  governanceEligible = true,
}) {
  const receiptId = systemSettlementReceiptId(jobId, milestone);
  const resolveInput = encodeFunctionData({
    abi: [RESOLVE_ABI],
    functionName: "resolve",
    args: [jobId, milestone, "0x1234", [worker], [paid]],
  });
  const rawEvents = [
    encodeRawEvent({
      abi: JOB_CREATED_EVENT,
      eventName: "JobCreated",
      args: {
        jobId,
        creator,
        funding,
        budget: paid,
        releaseId: `0x${"88".repeat(32)}`,
        planHash: `0x${"89".repeat(32)}`,
        issueId: issueHash,
      },
      transactionHash: jobTransactionHash,
      blockHash,
      blockNumber: blockNumber - 2,
      logIndex: 0,
      address: taskMarket,
    }),
    encodeRawEvent({
      abi: MILESTONE_DELIVERED_EVENT,
      eventName: "MilestoneDelivered",
      args: { jobId, milestone, deliveryHash: artifactDigest, proofRoundId: roundId },
      transactionHash: deliveryTransactionHash,
      blockHash,
      blockNumber: blockNumber - 1,
      logIndex: 0,
      address: taskMarket,
    }),
    encodeRawEvent({
      abi: OUTCOME_RECORDED_EVENT,
      eventName: "OutcomeRecorded",
      args: {
        source: settlementRouter,
        agent: worker,
        receiptId,
        units,
        successful: true,
      },
      transactionHash,
      blockHash,
      blockNumber,
      logIndex: 0,
      address: contributionLedger,
      transactionInput: resolveInput,
    }),
    encodeRawEvent({
      abi: MILESTONE_SETTLED_EVENT,
      eventName: "MilestoneSettled",
      args: { jobId, milestone, paid, keeper },
      transactionHash,
      blockHash,
      blockNumber,
      logIndex: 1,
      address: taskMarket,
      transactionInput: resolveInput,
    }),
  ];
  const stateReads = [
    {
      jobId,
      milestone,
      finalizedBlockNumber: blockNumber,
      job: {
        creator: creator.toLowerCase(),
        funding,
        state: 4,
        planHash: `0x${"89".repeat(32)}`,
        releaseId: `0x${"88".repeat(32)}`,
        issueId: issueHash.toLowerCase(),
        budget: paid.toString(),
        paid: paid.toString(),
        nextMilestone: 0,
        milestoneCount: 1,
        createdAt: 1,
      },
      milestoneState: {
        worker: worker.toLowerCase(),
        verifier: `0x${"33".repeat(20)}`,
        capability: capability.toLowerCase(),
        specificationHash: specificationHash.toLowerCase(),
        expectedEvidenceHash: `0x${"22".repeat(32)}`,
        payoutRoot: `0x${"23".repeat(32)}`,
        deliveryHash: artifactDigest.toLowerCase(),
        allocation: paid.toString(),
        workerBond: "1",
        keeperFee: "0",
        deadline: 1,
        capacityUnits: Number(units),
        minimumReveals: 3,
        passScoreBps: 8_000,
        commitWindow: 60,
        revealWindow: 60,
        state: 4,
        candidateAttested: false,
        adoptionRecorded: false,
      },
      governanceEligible,
    },
  ];
  return { rawEvents, stateReads, receiptId };
}

function normalizedContractPolicy(contracts) {
  const required = ["taskMarket", "contributionLedger", "settlementRouter"];
  const normalized = {};
  for (const key of required) {
    const value = contracts?.[key]?.toLowerCase?.();
    if (!ADDRESS_PATTERN.test(value ?? "")) {
      throw new Error(`V44_GOVERNANCE_CONTRACT_${key.toUpperCase()}_INVALID`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function decodeActualGovernanceRawLog(rawEvent, contracts) {
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
    rawEvent.topics.length < 1 ||
    rawEvent.topics.some((topic) => !HASH_PATTERN.test(topic ?? "")) ||
    typeof rawEvent.data !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/u.test(rawEvent.data.toLowerCase())
  ) {
    throw new Error("V44_GOVERNANCE_RAW_LOG_INVALID");
  }
  const definition = CHAIN_EVENT_BY_TOPIC.get(rawEvent.topics[0].toLowerCase());
  if (!definition) throw new Error("V44_GOVERNANCE_EVENT_UNSUPPORTED");
  if (rawEvent.address.toLowerCase() !== contracts[definition.contractKey]) {
    throw new Error("V44_GOVERNANCE_EVENT_EMITTER_UNAUTHORIZED");
  }
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: [definition.abi],
      eventName: definition.abi.name,
      topics: rawEvent.topics,
      data: rawEvent.data,
      strict: true,
    });
  } catch {
    throw new Error("V44_GOVERNANCE_EVENT_DECODE_FAILED");
  }
  const event = {
    eventId: `${rawEvent.transactionHash.toLowerCase()}:${rawEvent.logIndex}`,
    type: definition.type,
    transactionHash: rawEvent.transactionHash.toLowerCase(),
    blockHash: rawEvent.blockHash.toLowerCase(),
    blockNumber: rawEvent.blockNumber,
    logIndex: rawEvent.logIndex,
    emitter: rawEvent.address.toLowerCase(),
    transactionInputHash: sha256Json({
      transactionInput: rawEvent.transactionInput.toLowerCase(),
    }),
    args: jsonSafe(decoded.args),
    finalized: true,
    canonical: true,
  };
  if (definition.type === "OUTCOME_RECORDED") {
    if (event.args.source.toLowerCase() !== contracts.settlementRouter) {
      throw new Error("V44_GOVERNANCE_OUTCOME_SOURCE_UNAUTHORIZED");
    }
  }
  if (definition.type === "MILESTONE_SETTLED") {
    try {
      const call = decodeFunctionData({
        abi: [RESOLVE_ABI],
        data: rawEvent.transactionInput,
      });
      event.resolveInputValid =
        call.functionName === "resolve" &&
        call.args[0].toLowerCase() === event.args.jobId.toLowerCase() &&
        Number(call.args[1]) === Number(event.args.milestone);
    } catch {
      event.resolveInputValid = false;
    }
  }
  return event;
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
  contracts,
  finalizedBlockNumber,
  fetcher = fetch,
}) {
  if (
    typeof rpcUrl !== "string" ||
    !Number.isSafeInteger(fromBlock) ||
    fromBlock < 0 ||
    !contracts
  ) {
    throw new Error("V44_GOVERNANCE_RPC_POLICY_INVALID");
  }
  const contractPolicy = normalizedContractPolicy(contracts);
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
        address: [contractPolicy.taskMarket, contractPolicy.contributionLedger],
        fromBlock: rpcQuantity(fromBlock),
        toBlock: rpcQuantity(resolvedFinalizedBlockNumber),
        topics: [CHAIN_EVENT_DEFINITIONS.map((definition) => definition.topic0)],
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
  const decodedSettlements = rawEvents
    .map((rawEvent) => decodeActualGovernanceRawLog(rawEvent, contractPolicy))
    .filter((event) => event.type === "MILESTONE_SETTLED");
  const stateReads = [];
  for (const event of decodedSettlements) {
    const jobId = event.args.jobId.toLowerCase();
    const milestone = Number(event.args.milestone);
    const call = async (functionName, args) =>
      rpcRequest(
        rpcUrl,
        "eth_call",
        [
          {
            to: contractPolicy.taskMarket,
            data: encodeFunctionData({
              abi: TASK_MARKET_READ_ABI,
              functionName,
              args,
            }),
          },
          rpcQuantity(resolvedFinalizedBlockNumber),
        ],
        fetcher,
      );
    const [jobResult, milestoneResult, governanceEligibleResult] =
      await Promise.all([
        call("jobs", [jobId]),
        call("milestones", [jobId, milestone]),
        call("jobGovernanceEligible", [jobId]),
      ]);
    const jobOutputs = TASK_MARKET_READ_ABI.find(
      (entry) => entry.name === "jobs",
    ).outputs;
    const milestoneOutputs = TASK_MARKET_READ_ABI.find(
      (entry) => entry.name === "milestones",
    ).outputs;
    const jobValues = decodeAbiParameters(jobOutputs, jobResult);
    const milestoneValues = decodeAbiParameters(milestoneOutputs, milestoneResult);
    stateReads.push({
      jobId,
      milestone,
      finalizedBlockNumber: resolvedFinalizedBlockNumber,
      job: Object.fromEntries(
        jobOutputs.map((output, index) => [output.name, jsonSafe(jobValues[index])]),
      ),
      milestoneState: Object.fromEntries(
        milestoneOutputs.map((output, index) => [
          output.name,
          jsonSafe(milestoneValues[index]),
        ]),
      ),
      governanceEligible: decodeAbiParameters(
        [{ type: "bool" }],
        governanceEligibleResult,
      )[0],
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
    stateReads,
  };
}

function uniqueMap(values, keyOf, duplicateError) {
  const map = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (map.has(key)) throw new Error(duplicateError);
    map.set(key, value);
  }
  return map;
}

function lifecycleKey(jobId, milestone) {
  return `${jobId.toLowerCase()}:${Number(milestone)}`;
}

function deriveActualSystemSettlementEvents(decodedEvents, stateReads) {
  const jobs = uniqueMap(
    decodedEvents.filter((event) => event.type === "JOB_CREATED"),
    (event) => event.args.jobId.toLowerCase(),
    "V44_GOVERNANCE_JOB_CREATED_DUPLICATE",
  );
  const deliveries = uniqueMap(
    decodedEvents.filter((event) => event.type === "MILESTONE_DELIVERED"),
    (event) => lifecycleKey(event.args.jobId, event.args.milestone),
    "V44_GOVERNANCE_DELIVERY_DUPLICATE",
  );
  const outcomes = uniqueMap(
    decodedEvents.filter((event) => event.type === "OUTCOME_RECORDED"),
    (event) => event.args.receiptId.toLowerCase(),
    "V44_GOVERNANCE_OUTCOME_DUPLICATE",
  );
  const states = uniqueMap(
    stateReads ?? [],
    (state) => lifecycleKey(state.jobId, state.milestone),
    "V44_GOVERNANCE_STATE_READ_DUPLICATE",
  );
  const usedOutcomeIds = new Set();
  const systemEvents = [];
  for (const settled of decodedEvents.filter(
    (event) => event.type === "MILESTONE_SETTLED",
  )) {
    const jobId = settled.args.jobId.toLowerCase();
    const milestone = Number(settled.args.milestone);
    const key = lifecycleKey(jobId, milestone);
    const state = states.get(key);
    if (state?.governanceEligible !== true) continue;
    const jobCreated = jobs.get(jobId);
    const delivered = deliveries.get(key);
    const receiptId = systemSettlementReceiptId(jobId, milestone);
    const outcome = outcomes.get(receiptId);
    const funding = Number(state?.job?.funding);
    const chainLifecycleValid =
      [2, 3].includes(funding) &&
      Number(state?.job?.state) === 4 &&
      Number(state?.milestoneState?.state) === 4 &&
      settled.resolveInputValid === true &&
      jobCreated?.args?.issueId?.toLowerCase() ===
        state?.job?.issueId?.toLowerCase() &&
      Number(jobCreated?.args?.funding) === funding &&
      delivered?.args?.deliveryHash?.toLowerCase() ===
        state?.milestoneState?.deliveryHash?.toLowerCase() &&
      outcome?.transactionHash === settled.transactionHash &&
      outcome?.args?.agent?.toLowerCase() ===
        state?.milestoneState?.worker?.toLowerCase() &&
      BigInt(outcome?.args?.units ?? -1) ===
        BigInt(state?.milestoneState?.capacityUnits ?? -2) &&
      outcome?.args?.successful === true &&
      !usedOutcomeIds.has(receiptId);
    if (outcome) usedOutcomeIds.add(receiptId);
    systemEvents.push({
      eventId: settled.eventId,
      type: "SYSTEM_SETTLED",
      transactionHash: settled.transactionHash,
      blockHash: settled.blockHash,
      blockNumber: settled.blockNumber,
      logIndex: settled.logIndex,
      emitter: settled.emitter,
      transactionInputHash: settled.transactionInputHash,
      issueHash: state?.job?.issueId?.toLowerCase() ?? ZERO_HASH,
      jobId,
      milestone,
      roundId: delivered?.args?.proofRoundId?.toLowerCase() ?? ZERO_HASH,
      artifactDigest:
        state?.milestoneState?.deliveryHash?.toLowerCase() ?? ZERO_HASH,
      specificationHash:
        state?.milestoneState?.specificationHash?.toLowerCase() ?? ZERO_HASH,
      outcome: outcome
        ? {
            eventId: outcome.eventId,
            source: outcome.args.source.toLowerCase(),
            agent: outcome.args.agent.toLowerCase(),
            receiptId: outcome.args.receiptId.toLowerCase(),
            units: outcome.args.units,
            successful: outcome.args.successful,
            transactionHash: outcome.transactionHash,
            blockHash: outcome.blockHash,
            logIndex: outcome.logIndex,
          }
        : null,
      chainLifecycleValid,
      finalized: true,
      canonical: true,
    });
  }
  return systemEvents.sort((left, right) => left.eventId.localeCompare(right.eventId));
}

export function reconcileGovernanceEventSets({
  providers,
  localEventIds,
  contracts,
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
  let contractPolicy;
  try {
    contractPolicy = normalizedContractPolicy(contracts);
  } catch {
    return { eligible: false, reason: "EVENT_CONTRACT_POLICY_MISSING" };
  }
  const normalizedSets = providers.map((provider) =>
    [...(provider.rawEvents ?? [])]
      .map((rawEvent) => decodeActualGovernanceRawLog(rawEvent, contractPolicy))
      .filter((event) => event.blockNumber <= provider.finalizedBlockNumber)
      .map((event) => ({ ...event, eventHash: sha256Json(event) }))
      .sort((left, right) => left.eventId.localeCompare(right.eventId)),
  );
  const normalizedStateReads = providers.map((provider) =>
    [...(provider.stateReads ?? [])].sort((left, right) =>
      lifecycleKey(left.jobId, left.milestone).localeCompare(
        lifecycleKey(right.jobId, right.milestone),
      ),
    ),
  );
  const rawEvidenceRoot = sha256Json({
    events: normalizedSets[0],
    stateReads: normalizedStateReads[0],
  });
  if (
    normalizedSets.some(
      (events, index) =>
        sha256Json({ events, stateReads: normalizedStateReads[index] }) !==
        rawEvidenceRoot,
    )
  ) {
    return { eligible: false, reason: "EVENT_SET_CONFLICT" };
  }
  const canonicalEvents = deriveActualSystemSettlementEvents(
    normalizedSets[0],
    normalizedStateReads[0],
  );
  const canonicalRoot = sha256Json(canonicalEvents);
  const canonicalIds = canonicalEvents.map((event) => event.eventId);
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
    rawEvidenceRoot,
    events: canonicalEvents,
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
    specificationHash: value.specificationHash,
  });
}

export function validateExposureLifecycleAgainstEvents(ledger, events) {
  const successfulSlots = Object.values(ledger?.slots ?? {}).filter(
    (slot) => slot.state === SLOT_STATES.SUCCESSFULLY_CONSUMED,
  );
  const eventsByLifecycle = uniqueMap(
    events,
    (event) => lifecycleKey(event.jobId, event.milestone),
    "V44_EXPOSURE_CHAIN_EVENT_DUPLICATE",
  );
  const journalBySlot = new Map();
  for (const entry of ledger?.journal ?? []) {
    const entries = journalBySlot.get(entry.slotId) ?? [];
    entries.push(entry);
    journalBySlot.set(entry.slotId, entries);
  }
  const expectedStates = [
    SLOT_STATES.RESERVED_FOR_ISSUE,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    SLOT_STATES.VALIDATION_OPEN,
    SLOT_STATES.VALIDATOR_AUTHORIZED,
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
  ];
  for (const slot of successfulSlots) {
    const event = eventsByLifecycle.get(lifecycleKey(slot.jobId, slot.milestone));
    const states = (journalBySlot.get(slot.slotId) ?? []).map(
      (entry) => entry.state,
    );
    if (
      event?.issueHash !== slot.issueHash ||
      event?.chainLifecycleValid !== true ||
      states.length !== expectedStates.length ||
      states.some((state, index) => state !== expectedStates[index])
    ) {
      throw new Error("V44_EXPOSURE_JOURNAL_CHAIN_LIFECYCLE_MISMATCH");
    }
  }
  if (successfulSlots.length !== events.length) {
    throw new Error("V44_EXPOSURE_CHAIN_CARDINALITY_MISMATCH");
  }
  return {
    valid: true,
    successfulSlotCount: successfulSlots.length,
    chainEventCount: events.length,
  };
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
    const slotId = admission?.exposureSlotId;
    const slot = exposureLedger.slots?.[slotId];
    const admissionBundleValid =
      admission !== undefined &&
      admission.bundleHash === shadowBundleHash(admission);
    const settlementBundleValid =
      settlement !== undefined &&
      settlement.bundleHash === shadowBundleHash(settlement) &&
      admission?.sourceSnapshotDigest === settlement?.sourceSnapshotDigest &&
      admission?.exposureSlotId === settlement?.exposureSlotId;
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
      !usedSlots.has(slotId);
    const outcomeRecorded =
      event.chainLifecycleValid === true &&
      HASH_PATTERN.test(event.outcome?.receiptId ?? "") &&
      event.outcome.receiptId === systemSettlementReceiptId(event.jobId, event.milestone) &&
      event.outcome.successful === true &&
      !usedOutcomes.has(event.outcome.eventId);
    if (admissionBundleValid) usedAdmissions.add(admission.bundleHash);
    if (settlementBundleValid) usedSettlements.add(settlement.bundleHash);
    if (uniqueExposureSlotValid) usedSlots.add(slotId);
    if (outcomeRecorded) usedOutcomes.add(event.outcome.eventId);
    return {
      ...event,
      sourceSnapshotDigest: admission?.sourceSnapshotDigest ?? ZERO_HASH,
      admissionBundleHash: admission?.bundleHash ?? ZERO_HASH,
      settlementBundleHash: settlement?.bundleHash ?? ZERO_HASH,
      exposureSlotId: slotId ?? ZERO_HASH,
      outcomeEventId: event.outcome?.eventId ?? null,
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
  const exposureLifecycle = validateExposureLifecycleAgainstEvents(
    exposureLedger,
    derivedEvents,
  );
  return {
    complete,
    events: derivedEvents,
    admissionCount: usedAdmissions.size,
    settlementCount: usedSettlements.size,
    exposureCount: usedSlots.size,
    outcomeCount: usedOutcomes.size,
    exposureLifecycle,
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
    exposurePolicy = null,
    maturityAuthorizationPolicy = null,
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
  const trustedPreMatureMaximum =
    exposurePolicy?.preMatureMaximumSuccessfulSystemSettlements ??
    PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS;
  if (
    summary.maximumSuccessfulSystemSettlements !== trustedPreMatureMaximum
  ) {
    throw new Error("V44_AUTONOMY_EXPOSURE_POLICY_MISMATCH");
  }
  let maturityAuthorization = null;
  if (summary.worstCaseSuccessfulSettlements > trustedPreMatureMaximum) {
    if (
      summary.worstCaseSuccessfulSettlements !== trustedPreMatureMaximum + 1 ||
      evidence.exposureLedger.maturityAuthorizationConsumed !== true ||
      maturityAuthorizationPolicy === null
    ) {
      throw new Error("V44_AUTONOMY_EXPOSURE_LIMIT_EXCEEDED");
    }
    maturityAuthorization = validateMaturityAuthorization(
      evidence.maturityAuthorization,
      {
        ...maturityAuthorizationPolicy,
        atMs: evaluationTimeMs,
        expectedExposureSlotId:
          evidence.maturityAuthorization?.authorizedExposureSlotId ?? null,
        preMatureMaximumSuccessfulSystemSettlements: trustedPreMatureMaximum,
      },
    );
    if (
      maturityAuthorization.authorizationId !==
        evidence.exposureLedger.maturityAuthorizationId ||
      !evidence.exposureLedger.slots?.[
        evidence.maturityAuthorization.authorizedExposureSlotId
      ]
    ) {
      throw new Error("V44_AUTONOMY_MATURITY_AUTHORIZATION_MISMATCH");
    }
  }
  const admissionBundles = evidence.admissionBundles ?? [];
  const settlementBundles = evidence.settlementBundles ?? [];
  const signerPolicyReady = (policy) =>
    Number.isSafeInteger(policy?.threshold) &&
    policy.threshold >= 2 &&
    Array.isArray(policy?.authorizedPublicKeys) &&
    policy.authorizedPublicKeys.length >= policy.threshold;
  if (
    (admissionBundles.length > 0 || settlementBundles.length > 0) &&
    (!signerPolicyReady(controlDomainPolicy) ||
      !signerPolicyReady(checkpointPolicy))
  ) {
    return {
      valid: false,
      status: "PENDING_POLICY_CONFIGURATION",
      exposure: summary,
      exposureJournal,
      maturityAuthorization,
      contamination: {
        governanceContaminated: "UNVERIFIED",
        violationEventIds: [],
        finalizedEventCount: 0,
      },
    };
  }
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
    contracts: governanceEventPolicy?.contracts ?? null,
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
      maturityAuthorization,
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
      maturityAuthorization,
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
    maturityAuthorization,
    checkpoint,
    eventReconciliation,
    settlementEvidence,
    contamination,
  };
}
