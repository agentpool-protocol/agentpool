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
  transitionIssueProposed:
    "IssueProposed(uint256,bytes32,address,bytes32)",
  transitionVoteCommitted: "VoteCommitted(uint256,address,uint256)",
  transitionVoteRevealed:
    "VoteRevealed(uint256,address,bool,bytes32,uint256)",
  transitionProposalClosed: "ProposalClosed(uint256,uint8)",
  matureIssueProposed: "IssueProposed(uint256,bytes32,address)",
  matureVoteCommitted: "VoteCommitted(uint256,address,uint256)",
  matureVoteRevealed: "VoteRevealed(uint256,address,bool,uint256)",
  matureProposalClosed: "ProposalClosed(uint256,uint8)",
  transitionIssueApproved: "TransitionIssueApproved(bytes32)",
  matureIssueApproved: "MatureIssueApproved(bytes32)",
  issueConsumed: "IssueConsumed(bytes32,bytes32,address,uint256,uint256)",
  jobCreated:
    "JobCreated(bytes32,address,uint8,uint256,bytes32,bytes32,bytes32)",
  milestoneDelivered: "MilestoneDelivered(bytes32,uint32,bytes32,bytes32)",
  roundOpened: "RoundOpened(bytes32,uint64,uint64,bytes32,uint16)",
  evaluationCommitted: "EvaluationCommitted(bytes32,address,bytes32)",
  evaluationRevealed:
    "EvaluationRevealed(bytes32,address,uint16,bytes32)",
  milestoneSettled: "MilestoneSettled(bytes32,uint32,uint256,address)",
  outcomeRecorded: "OutcomeRecorded(address,address,bytes32,uint256,bool)",
});

const TRANSITION_ISSUE_PROPOSED_EVENT = {
  type: "event",
  name: "IssueProposed",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "issueHash", type: "bytes32", indexed: true },
    { name: "proposer", type: "address", indexed: true },
    { name: "needEvidenceHash", type: "bytes32", indexed: false },
  ],
};
const TRANSITION_VOTE_COMMITTED_EVENT = {
  type: "event",
  name: "VoteCommitted",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "voter", type: "address", indexed: true },
    { name: "weight", type: "uint256", indexed: false },
  ],
};
const TRANSITION_VOTE_REVEALED_EVENT = {
  type: "event",
  name: "VoteRevealed",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "voter", type: "address", indexed: true },
    { name: "support", type: "bool", indexed: false },
    { name: "evidenceHash", type: "bytes32", indexed: false },
    { name: "weight", type: "uint256", indexed: false },
  ],
};
const PROPOSAL_CLOSED_EVENT = {
  type: "event",
  name: "ProposalClosed",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "state", type: "uint8", indexed: false },
  ],
};
const MATURE_ISSUE_PROPOSED_EVENT = {
  type: "event",
  name: "IssueProposed",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "issueHash", type: "bytes32", indexed: true },
    { name: "proposer", type: "address", indexed: true },
  ],
};
const MATURE_VOTE_REVEALED_EVENT = {
  type: "event",
  name: "VoteRevealed",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "voter", type: "address", indexed: true },
    { name: "support", type: "bool", indexed: false },
    { name: "weight", type: "uint256", indexed: false },
  ],
};
const ISSUE_APPROVED_EVENT = (name) => ({
  type: "event",
  name,
  inputs: [{ name: "issueHash", type: "bytes32", indexed: true }],
});
const ISSUE_CONSUMED_EVENT = {
  type: "event",
  name: "IssueConsumed",
  inputs: [
    { name: "issueId", type: "bytes32", indexed: true },
    { name: "operatorGroup", type: "bytes32", indexed: true },
    { name: "proposer", type: "address", indexed: true },
    { name: "budget", type: "uint256", indexed: false },
    { name: "candidates", type: "uint256", indexed: false },
  ],
};

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
const ROUND_OPENED_EVENT = {
  type: "event",
  name: "RoundOpened",
  inputs: [
    { name: "roundId", type: "bytes32", indexed: true },
    { name: "commitDeadline", type: "uint64", indexed: false },
    { name: "revealDeadline", type: "uint64", indexed: false },
    { name: "validatorRoot", type: "bytes32", indexed: false },
    { name: "minimumGroups", type: "uint16", indexed: false },
  ],
};
const EVALUATION_COMMITTED_EVENT = {
  type: "event",
  name: "EvaluationCommitted",
  inputs: [
    { name: "roundId", type: "bytes32", indexed: true },
    { name: "validator", type: "address", indexed: true },
    { name: "operatorGroup", type: "bytes32", indexed: true },
  ],
};
const EVALUATION_REVEALED_EVENT = {
  type: "event",
  name: "EvaluationRevealed",
  inputs: [
    { name: "roundId", type: "bytes32", indexed: true },
    { name: "validator", type: "address", indexed: true },
    { name: "scoreBps", type: "uint16", indexed: false },
    { name: "evidenceHash", type: "bytes32", indexed: false },
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
    type: "TRANSITION_ISSUE_PROPOSED",
    signature: V44_CHAIN_EVENT_SIGNATURES.transitionIssueProposed,
    abi: TRANSITION_ISSUE_PROPOSED_EVENT,
    contractKey: "transitionIssueConsensus",
  },
  {
    type: "TRANSITION_VOTE_COMMITTED",
    signature: V44_CHAIN_EVENT_SIGNATURES.transitionVoteCommitted,
    abi: TRANSITION_VOTE_COMMITTED_EVENT,
    contractKey: "transitionIssueConsensus",
  },
  {
    type: "TRANSITION_VOTE_REVEALED",
    signature: V44_CHAIN_EVENT_SIGNATURES.transitionVoteRevealed,
    abi: TRANSITION_VOTE_REVEALED_EVENT,
    contractKey: "transitionIssueConsensus",
  },
  {
    type: "TRANSITION_PROPOSAL_CLOSED",
    signature: V44_CHAIN_EVENT_SIGNATURES.transitionProposalClosed,
    abi: PROPOSAL_CLOSED_EVENT,
    contractKey: "transitionIssueConsensus",
  },
  {
    type: "MATURE_ISSUE_PROPOSED",
    signature: V44_CHAIN_EVENT_SIGNATURES.matureIssueProposed,
    abi: MATURE_ISSUE_PROPOSED_EVENT,
    contractKey: "issueConsensus",
  },
  {
    type: "MATURE_VOTE_COMMITTED",
    signature: V44_CHAIN_EVENT_SIGNATURES.matureVoteCommitted,
    abi: TRANSITION_VOTE_COMMITTED_EVENT,
    contractKey: "issueConsensus",
  },
  {
    type: "MATURE_VOTE_REVEALED",
    signature: V44_CHAIN_EVENT_SIGNATURES.matureVoteRevealed,
    abi: MATURE_VOTE_REVEALED_EVENT,
    contractKey: "issueConsensus",
  },
  {
    type: "MATURE_PROPOSAL_CLOSED",
    signature: V44_CHAIN_EVENT_SIGNATURES.matureProposalClosed,
    abi: PROPOSAL_CLOSED_EVENT,
    contractKey: "issueConsensus",
  },
  {
    type: "TRANSITION_ISSUE_APPROVED",
    signature: V44_CHAIN_EVENT_SIGNATURES.transitionIssueApproved,
    abi: ISSUE_APPROVED_EVENT("TransitionIssueApproved"),
    contractKey: "systemIssueGate",
  },
  {
    type: "MATURE_ISSUE_APPROVED",
    signature: V44_CHAIN_EVENT_SIGNATURES.matureIssueApproved,
    abi: ISSUE_APPROVED_EVENT("MatureIssueApproved"),
    contractKey: "systemIssueGate",
  },
  {
    type: "ISSUE_CONSUMED",
    signature: V44_CHAIN_EVENT_SIGNATURES.issueConsumed,
    abi: ISSUE_CONSUMED_EVENT,
    contractKey: "systemIssueGate",
  },
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
    type: "ROUND_OPENED",
    signature: V44_CHAIN_EVENT_SIGNATURES.roundOpened,
    abi: ROUND_OPENED_EVENT,
    contractKey: "proofRegistry",
  },
  {
    type: "EVALUATION_COMMITTED",
    signature: V44_CHAIN_EVENT_SIGNATURES.evaluationCommitted,
    abi: EVALUATION_COMMITTED_EVENT,
    contractKey: "proofRegistry",
  },
  {
    type: "EVALUATION_REVEALED",
    signature: V44_CHAIN_EVENT_SIGNATURES.evaluationRevealed,
    abi: EVALUATION_REVEALED_EVENT,
    contractKey: "proofRegistry",
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
const CHAIN_EVENT_BY_TOPIC = new Map();
for (const definition of CHAIN_EVENT_DEFINITIONS) {
  const existing = CHAIN_EVENT_BY_TOPIC.get(definition.topic0) ?? [];
  existing.push(definition);
  CHAIN_EVENT_BY_TOPIC.set(definition.topic0, existing);
}

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
const DELIVER_ABI = {
  type: "function",
  name: "deliver",
  stateMutability: "nonpayable",
  inputs: [
    { name: "jobId", type: "bytes32" },
    { name: "milestoneIndex", type: "uint32" },
    { name: "deliveryHash", type: "bytes32" },
  ],
  outputs: [],
};
const FINALIZE_ABI = {
  type: "function",
  name: "finalize",
  stateMutability: "nonpayable",
  inputs: [{ name: "proposalId", type: "uint256" }],
  outputs: [],
};
const PROOF_REGISTRY_READ_ABI = [
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "bytes32" }],
    outputs: [
      { name: "commitDeadline", type: "uint64" },
      { name: "revealDeadline", type: "uint64" },
      { name: "committed", type: "uint16" },
      { name: "revealed", type: "uint16" },
      { name: "representedGroups", type: "uint16" },
      { name: "minimumGroups", type: "uint16" },
      { name: "validatorRoot", type: "bytes32" },
      { name: "excludedGroup", type: "bytes32" },
      { name: "opened", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "medianScore",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "bytes32" }],
    outputs: [{ name: "scoreBps", type: "uint16" }],
  },
];
const SYSTEM_ISSUE_GATE_READ_ABI = [
  {
    type: "function",
    name: "dynamicMaxCandidates",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "maximum", type: "uint16" }],
  },
  {
    type: "function",
    name: "usage",
    stateMutability: "view",
    inputs: [{ name: "issueId", type: "bytes32" }],
    outputs: [
      { name: "termsHash", type: "bytes32" },
      { name: "committedBudget", type: "uint128" },
      { name: "candidates", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "transitionApprovedIssueHash",
    stateMutability: "view",
    inputs: [{ name: "issueHash", type: "bytes32" }],
    outputs: [{ name: "approved", type: "bool" }],
  },
  {
    type: "function",
    name: "approvedIssueHash",
    stateMutability: "view",
    inputs: [{ name: "issueHash", type: "bytes32" }],
    outputs: [{ name: "approved", type: "bool" }],
  },
];
const TASK_MARKET_READ_ABI = [
  {
    type: "function",
    name: "MAX_GOVERNANCE_MILESTONES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "maximum", type: "uint32" }],
  },
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

function appendExposureJournal(ledger, action, slot, chainAnchor = null) {
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
    chainAnchor,
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

function successfulExposure(ledger) {
  return Object.values(ledger?.slots ?? {}).filter(
    (slot) => slot.state === SLOT_STATES.SUCCESSFULLY_CONSUMED,
  ).length;
}

export function reserveExposureSlot(
  ledger,
  descriptor,
  {
    maturityAuthorization = null,
    maturityAuthorizationPolicy = null,
    evaluationTimeMs = Date.now(),
    chainAnchor = null,
  } = {},
) {
  const slotId = exposureSlotId(descriptor);
  if (ledger.slots[slotId]) {
    throw new Error("V44_EXPOSURE_SLOT_DUPLICATE");
  }
  const derivedSuccessfulSettlements = successfulExposure(ledger);
  if (ledger.successfulSystemSettlements !== derivedSuccessfulSettlements) {
    throw new Error("V44_EXPOSURE_SUCCESS_COUNTER_MISMATCH");
  }
  const worstCase = derivedSuccessfulSettlements + liveExposure(ledger) + 1;
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
  appendExposureJournal(ledger, "RESERVE", ledger.slots[slotId], chainAnchor);
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
    chainAnchor = null,
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
  appendExposureJournal(ledger, "TRANSITION", slot, chainAnchor);
  return slot;
}

export function exposureSummary(ledger) {
  const states = Object.fromEntries(
    Object.values(SLOT_STATES).map((state) => [state, 0]),
  );
  for (const slot of Object.values(ledger.slots)) states[slot.state] += 1;
  const derivedSuccessfulSettlements = successfulExposure(ledger);
  return {
    successfulSystemSettlements: derivedSuccessfulSettlements,
    declaredSuccessfulSystemSettlements:
      ledger.successfulSystemSettlements,
    liveExposure: liveExposure(ledger),
    worstCaseSuccessfulSettlements:
      derivedSuccessfulSettlements + liveExposure(ledger),
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

function validatedSignerBindings(
  authorizedPublicKeys,
  signerBindings,
  threshold,
  errorCode,
) {
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    authorizedPublicKeys.length < threshold ||
    !Array.isArray(signerBindings)
  ) {
    throw new Error(errorCode);
  }
  const authorizedIds = new Set(
    authorizedPublicKeys.map((publicKeyPem) => observerKeyId(publicKeyPem)),
  );
  const bindings = new Map();
  for (const binding of signerBindings) {
    if (
      !authorizedIds.has(binding.signerKeyId) ||
      typeof binding.controllerDomainId !== "string" ||
      binding.controllerDomainId.length < 3 ||
      typeof binding.custodyDomainId !== "string" ||
      binding.custodyDomainId.length < 3 ||
      !HASH_PATTERN.test(binding.corroborationEvidenceHash ?? "") ||
      bindings.has(binding.signerKeyId)
    ) {
      throw new Error(errorCode);
    }
    bindings.set(binding.signerKeyId, binding);
  }
  if (
    bindings.size < threshold ||
    new Set(
      [...bindings.values()].map((binding) => binding.controllerDomainId),
    ).size < threshold ||
    new Set(
      [...bindings.values()].map((binding) => binding.custodyDomainId),
    ).size < threshold
  ) {
    throw new Error(errorCode);
  }
  return bindings;
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
  admissionBundleHash,
  precommitCheckpointHash,
  providerSnapshots,
  readinessEvidence,
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
    admissionBundleHash,
    precommitCheckpointHash,
    providerSnapshots,
    readinessEvidence,
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
    signerBindings = [],
    threshold = 2,
    atMs = Date.now(),
    expectedSourceCommit = null,
    expectedDeploymentManifestSha256 = null,
    expectedExposureSlotId = null,
    trustedProviderSnapshots = null,
    trustedReadinessEvidence = null,
    providerOperatorPolicy = null,
    preMatureMaximumSuccessfulSystemSettlements =
      PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
    minimumNonMaintainerVotingAgents = 5,
    minimumOnchainGroups = 3,
    minimumCorroboratedControlDomains = 3,
    maximumControlDomainShareBps = 2_999,
    agentControlDomainBindings = [],
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
    !HASH_PATTERN.test(authorization.admissionBundleHash ?? "") ||
    !HASH_PATTERN.test(authorization.precommitCheckpointHash ?? "") ||
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
  const readiness = authorization.readinessEvidence;
  if (
    !readiness ||
    !trustedReadinessEvidence ||
    sha256Json(readiness) !== sha256Json(trustedReadinessEvidence) ||
    !ADDRESS_PATTERN.test(readiness.proposalBond?.token?.toLowerCase?.() ?? "") ||
    !ADDRESS_PATTERN.test(readiness.proposalBond?.owner?.toLowerCase?.() ?? "") ||
    !ADDRESS_PATTERN.test(readiness.proposalBond?.spender?.toLowerCase?.() ?? "") ||
    BigInt(readiness.proposalBond?.requiredAmount ?? -1) < 0n ||
    BigInt(readiness.proposalBond?.balance ?? -1) <
      BigInt(readiness.proposalBond?.requiredAmount ?? 0) ||
    BigInt(readiness.proposalBond?.allowance ?? -1) <
      BigInt(readiness.proposalBond?.requiredAmount ?? 0) ||
    !Number.isSafeInteger(readiness.proposalBond?.blockNumber) ||
    !HASH_PATTERN.test(readiness.proposalBond?.evidenceHash ?? "") ||
    !HASH_PATTERN.test(readiness.recoveryIssue?.issueId ?? "") ||
    readiness.recoveryIssue?.state !== "AVAILABLE" ||
    !HASH_PATTERN.test(readiness.recoveryIssue?.evidenceHash ?? "") ||
    !HASH_PATTERN.test(readiness.recoveryJob?.jobId ?? "") ||
    readiness.recoveryJob?.state !== "AVAILABLE" ||
    !HASH_PATTERN.test(readiness.recoveryJob?.evidenceHash ?? "") ||
    !HASH_PATTERN.test(readiness.governanceDryRun?.transcriptHash ?? "") ||
    typeof readiness.governanceDryRun?.verifierVersion !== "string" ||
    readiness.governanceDryRun.verifierVersion.length < 3 ||
    readiness.governanceDryRun?.passed !== true ||
    !HASH_PATTERN.test(readiness.incidentLedger?.root ?? "") ||
    readiness.incidentLedger?.unresolvedCriticalHigh !== 0 ||
    !HASH_PATTERN.test(readiness.maintainerWorkPower?.agentSetRoot ?? "") ||
    !Number.isSafeInteger(readiness.maintainerWorkPower?.epoch) ||
    BigInt(readiness.maintainerWorkPower?.units ?? -1) !== 0n
  ) {
    throw new Error("V44_MATURITY_READINESS_EVIDENCE_INVALID");
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
  const trustedOperators = new Map(
    (providerOperatorPolicy?.providers ?? []).map((provider) => [
      provider.operatorId,
      provider,
    ]),
  );
  if (
    providerOperatorPolicy?.configurationStatus !== "ACTIVE" ||
    authorization.providerSnapshots.some((provider) => {
      const trusted = trustedOperators.get(provider.providerOperatorId);
      return (
        provider.identity !== provider.providerOperatorId ||
        !trusted?.allowedOrigins?.includes(provider.origin)
      );
    }) ||
    new Set(
      authorization.providerSnapshots.map(
        (provider) =>
          trustedOperators.get(provider.providerOperatorId)?.custodyDomainId,
      ),
    ).size < 2
  ) {
    throw new Error("V44_MATURITY_PROVIDER_OPERATOR_POLICY_INVALID");
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
  const agentBindings = new Map(
    agentControlDomainBindings.map((binding) => [
      binding.agent?.toLowerCase?.(),
      binding,
    ]),
  );
  if (
    !Array.isArray(agents) ||
    agents.length < minimumNonMaintainerVotingAgents ||
    new Set(agents.map((agent) => agent.agent?.toLowerCase())).size !==
      agents.length ||
    new Set(agents.map((agent) => agent.operatorGroup)).size <
      minimumOnchainGroups ||
    new Set(
      agents.map(
        (agent) =>
          agentBindings.get(agent.agent?.toLowerCase?.())?.controllerDomainId,
      ),
    ).size <
      minimumCorroboratedControlDomains ||
    agents.some(
      (agent) =>
        !ADDRESS_PATTERN.test(agent.agent?.toLowerCase?.() ?? "") ||
        !HASH_PATTERN.test(agent.operatorGroup ?? "") ||
        !agentBindings.has(agent.agent.toLowerCase()) ||
        typeof agentBindings.get(agent.agent.toLowerCase()).controllerDomainId !==
          "string" ||
        typeof agentBindings.get(agent.agent.toLowerCase()).custodyDomainId !==
          "string" ||
        !HASH_PATTERN.test(
          agentBindings.get(agent.agent.toLowerCase())
            .corroborationEvidenceHash ?? "",
        ) ||
        BigInt(agent.workPower ?? 0) <= 0n,
    ) ||
    snapshot.successfulSystemSettlements !==
      preMatureMaximumSuccessfulSystemSettlements
  ) {
    throw new Error("V44_MATURITY_CHAIN_REQUIREMENTS_INVALID");
  }
  const chainSnapshot = firstProvider.chainSnapshot;
  const canonicalVotingAgents = agents
    .map(({ agent, operatorGroup, workPower }) => ({
      agent: agent.toLowerCase(),
      operatorGroup,
      workPower: String(workPower),
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));
  const canonicalTotalWorkPower = canonicalVotingAgents.reduce(
    (total, agent) => total + BigInt(agent.workPower),
    0n,
  );
  if (
    chainSnapshot?.successfulSystemSettlements !==
      snapshot.successfulSystemSettlements ||
    chainSnapshot?.eligibleAgentCount < minimumNonMaintainerVotingAgents ||
    chainSnapshot?.eligibleGroupCount < minimumOnchainGroups ||
    chainSnapshot?.populationComplete !== true ||
    chainSnapshot?.positiveVotingAgentCount !== canonicalVotingAgents.length ||
    chainSnapshot?.positiveVotingGroupCount !==
      new Set(canonicalVotingAgents.map((agent) => agent.operatorGroup)).size ||
    BigInt(chainSnapshot?.totalWorkPower ?? -1) !==
      canonicalTotalWorkPower ||
    chainSnapshot?.populationRoot !== sha256Json(canonicalVotingAgents) ||
    sha256Json(chainSnapshot?.votingAgents ?? null) !==
      sha256Json(canonicalVotingAgents)
  ) {
    throw new Error("V44_MATURITY_CHAIN_METRICS_MISMATCH");
  }
  const totalWorkPower = agents.reduce(
    (total, agent) => total + BigInt(agent.workPower),
    0n,
  );
  const domainPower = new Map();
  for (const agent of agents) {
    const controlDomain = agentBindings.get(
      agent.agent.toLowerCase(),
    ).controllerDomainId;
    domainPower.set(
      controlDomain,
      (domainPower.get(controlDomain) ?? 0n) + BigInt(agent.workPower),
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
  const bindings = validatedSignerBindings(
    authorizedPublicKeys,
    signerBindings,
    threshold,
    "V44_MATURITY_SIGNER_POLICY_INVALID",
  );
  const validSignatures = (authorization.signatures ?? []).filter(
    (signature) =>
      bindings.has(signature.signerKeyId) &&
      signature.signerKeyId === observerKeyId(signature.publicKeyPem) &&
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
    new Set(
      validSignatures.map(
        (signature) => bindings.get(signature.signerKeyId).controllerDomainId,
      ),
    ).size < threshold ||
    new Set(
      validSignatures.map(
        (signature) => bindings.get(signature.signerKeyId).custodyDomainId,
      ),
    ).size < threshold
  ) {
    throw new Error("V44_MATURITY_SIGNATURE_THRESHOLD");
  }
  return {
    valid: true,
    authorizationId: authorization.authorizationId,
    finalizedBlockNumber: firstProvider.finalizedBlockNumber,
    finalizedBlockHash: firstProvider.finalizedBlockHash.toLowerCase(),
    snapshotRoot,
    admissionBundleHash: authorization.admissionBundleHash,
    precommitCheckpointHash: authorization.precommitCheckpointHash,
    requiredJobPlanHash: maturityAuthorizationPlanHash(
      authorization.authorizationId,
    ),
  };
}

export function validateControlDomainRegistry(
  registry,
  {
    authorizedPublicKeys = [],
    signerBindings = [],
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
  const bindings = validatedSignerBindings(
    authorizedPublicKeys,
    signerBindings,
    threshold,
    "V44_CONTROL_DOMAIN_REGISTRY_POLICY_INVALID",
  );
  const validSignatures = (registry.signatures ?? []).filter(
    (signature) =>
      bindings.has(signature.signerKeyId) &&
      signature.signerKeyId === observerKeyId(signature.publicKeyPem) &&
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
    new Set(
      validSignatures.map(
        (signature) => bindings.get(signature.signerKeyId).controllerDomainId,
      ),
    ).size < threshold ||
    new Set(
      validSignatures.map(
        (signature) => bindings.get(signature.signerKeyId).custodyDomainId,
      ),
    ).size < threshold
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
  transactionTo = address,
  blockTimestampMs = blockNumber * 1_000,
  transactionInput = "0x",
}) {
  const nonIndexed = abi.inputs.filter((input) => input.indexed !== true);
  return {
    transactionHash: transactionHash.toLowerCase(),
    blockHash: blockHash.toLowerCase(),
    blockNumber,
    logIndex,
    address: address.toLowerCase(),
    transactionTo: transactionTo.toLowerCase(),
    blockTimestampMs,
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

export function admissionBundlePlanHash(bundleHash) {
  if (!HASH_PATTERN.test(bundleHash ?? "")) {
    throw new Error("V44_ADMISSION_BUNDLE_HASH_INVALID");
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }],
      ["AGENTPOOL_V44_ADMISSION_BUNDLE", bundleHash],
    ),
  ).toLowerCase();
}

export function maturityAuthorizationPlanHash(authorizationId) {
  if (!HASH_PATTERN.test(authorizationId ?? "")) {
    throw new Error("V44_MATURITY_AUTHORIZATION_HASH_INVALID");
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }],
      ["AGENTPOOL_V44_MATURITY_AUTHORIZATION", authorizationId],
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
  proofRegistry = `0x${"14".repeat(20)}`,
  systemIssueGate = `0x${"15".repeat(20)}`,
  transitionIssueConsensus = `0x${"16".repeat(20)}`,
  issueHash,
  issueTermsHash = `0x${"18".repeat(32)}`,
  jobId,
  milestone,
  roundId,
  artifactDigest,
  specificationHash,
  admissionBundleHash = `0x${"19".repeat(32)}`,
  settlementBundleHash = `0x${"1a".repeat(32)}`,
  validatorScoreBps = 9_000,
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
  const planHash = admissionBundlePlanHash(admissionBundleHash);
  const resolveInput = encodeFunctionData({
    abi: [RESOLVE_ABI],
    functionName: "resolve",
    args: [jobId, milestone, "0x1234", [worker], [paid]],
  });
  const deliverInput = encodeFunctionData({
    abi: [DELIVER_ABI],
    functionName: "deliver",
    args: [jobId, milestone, artifactDigest],
  });
  const finalizeInput = encodeFunctionData({
    abi: [FINALIZE_ABI],
    functionName: "finalize",
    args: [1n],
  });
  const proposalTransactionHash = `0x${"81".repeat(32)}`;
  const commitTransactionHashes = [
    `0x${"82".repeat(32)}`,
    `0x${"83".repeat(32)}`,
  ];
  const revealTransactionHashes = [
    `0x${"84".repeat(32)}`,
    `0x${"85".repeat(32)}`,
  ];
  const approvalTransactionHash = `0x${"86".repeat(32)}`;
  const evaluationCommitHashes = [
    `0x${"93".repeat(32)}`,
    `0x${"94".repeat(32)}`,
    `0x${"95".repeat(32)}`,
  ];
  const evaluationRevealHashes = [
    `0x${"96".repeat(32)}`,
    `0x${"97".repeat(32)}`,
    `0x${"98".repeat(32)}`,
  ];
  const transitionVoters = [
    `0x${"21".repeat(20)}`,
    `0x${"22".repeat(20)}`,
  ];
  const validators = [
    `0x${"31".repeat(20)}`,
    `0x${"32".repeat(20)}`,
    `0x${"33".repeat(20)}`,
  ];
  const rawEvents = [
    encodeRawEvent({
      abi: TRANSITION_ISSUE_PROPOSED_EVENT,
      eventName: "IssueProposed",
      args: {
        proposalId: 1n,
        issueHash: issueTermsHash,
        proposer: creator,
        needEvidenceHash: admissionBundleHash,
      },
      transactionHash: proposalTransactionHash,
      blockHash,
      blockNumber: blockNumber - 9,
      logIndex: 0,
      address: transitionIssueConsensus,
      transactionTo: transitionIssueConsensus,
    }),
    ...transitionVoters.map((voter, index) =>
      encodeRawEvent({
        abi: TRANSITION_VOTE_COMMITTED_EVENT,
        eventName: "VoteCommitted",
        args: { proposalId: 1n, voter, weight: 1n },
        transactionHash: commitTransactionHashes[index],
        blockHash,
        blockNumber: blockNumber - 8 + index,
        logIndex: 0,
        address: transitionIssueConsensus,
        transactionTo: transitionIssueConsensus,
      }),
    ),
    ...transitionVoters.map((voter, index) =>
      encodeRawEvent({
        abi: TRANSITION_VOTE_REVEALED_EVENT,
        eventName: "VoteRevealed",
        args: {
          proposalId: 1n,
          voter,
          support: true,
          evidenceHash: admissionBundleHash,
          weight: 1n,
        },
        transactionHash: revealTransactionHashes[index],
        blockHash,
        blockNumber: blockNumber - 6 + index,
        logIndex: 0,
        address: transitionIssueConsensus,
        transactionTo: transitionIssueConsensus,
      }),
    ),
    encodeRawEvent({
      abi: ISSUE_APPROVED_EVENT("TransitionIssueApproved"),
      eventName: "TransitionIssueApproved",
      args: { issueHash: issueTermsHash },
      transactionHash: approvalTransactionHash,
      blockHash,
      blockNumber: blockNumber - 4,
      logIndex: 0,
      address: systemIssueGate,
      transactionTo: transitionIssueConsensus,
      transactionInput: finalizeInput,
    }),
    encodeRawEvent({
      abi: PROPOSAL_CLOSED_EVENT,
      eventName: "ProposalClosed",
      args: { proposalId: 1n, state: 3 },
      transactionHash: approvalTransactionHash,
      blockHash,
      blockNumber: blockNumber - 4,
      logIndex: 1,
      address: transitionIssueConsensus,
      transactionTo: transitionIssueConsensus,
      transactionInput: finalizeInput,
    }),
    encodeRawEvent({
      abi: ISSUE_CONSUMED_EVENT,
      eventName: "IssueConsumed",
      args: {
        issueId: issueHash,
        operatorGroup: `0x${"2a".repeat(32)}`,
        proposer: creator,
        budget: paid,
        candidates: 1n,
      },
      transactionHash: jobTransactionHash,
      blockHash,
      blockNumber: blockNumber - 3,
      logIndex: 0,
      address: systemIssueGate,
      transactionTo: taskMarket,
    }),
    encodeRawEvent({
      abi: JOB_CREATED_EVENT,
      eventName: "JobCreated",
      args: {
        jobId,
        creator,
        funding,
        budget: paid,
        releaseId: `0x${"88".repeat(32)}`,
        planHash,
        issueId: issueHash,
      },
      transactionHash: jobTransactionHash,
      blockHash,
      blockNumber: blockNumber - 3,
      logIndex: 1,
      address: taskMarket,
      transactionTo: taskMarket,
    }),
    encodeRawEvent({
      abi: ROUND_OPENED_EVENT,
      eventName: "RoundOpened",
      args: {
        roundId,
        commitDeadline: 100,
        revealDeadline: 200,
        validatorRoot: `0x${"2b".repeat(32)}`,
        minimumGroups: 3,
      },
      transactionHash: deliveryTransactionHash,
      blockHash,
      blockNumber: blockNumber - 2,
      logIndex: 0,
      address: proofRegistry,
      transactionTo: taskMarket,
      transactionInput: deliverInput,
    }),
    encodeRawEvent({
      abi: MILESTONE_DELIVERED_EVENT,
      eventName: "MilestoneDelivered",
      args: { jobId, milestone, deliveryHash: artifactDigest, proofRoundId: roundId },
      transactionHash: deliveryTransactionHash,
      blockHash,
      blockNumber: blockNumber - 2,
      logIndex: 1,
      address: taskMarket,
      transactionTo: taskMarket,
      transactionInput: deliverInput,
    }),
    ...validators.map((validator, index) =>
      encodeRawEvent({
        abi: EVALUATION_COMMITTED_EVENT,
        eventName: "EvaluationCommitted",
        args: {
          roundId,
          validator,
          operatorGroup: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        },
        transactionHash: evaluationCommitHashes[index],
        blockHash,
        blockNumber: blockNumber - 1,
        logIndex: index,
        address: proofRegistry,
        transactionTo: proofRegistry,
      }),
    ),
    ...validators.map((validator, index) =>
      encodeRawEvent({
        abi: EVALUATION_REVEALED_EVENT,
        eventName: "EvaluationRevealed",
        args: {
          roundId,
          validator,
          scoreBps: validatorScoreBps,
          evidenceHash: settlementBundleHash,
        },
        transactionHash: evaluationRevealHashes[index],
        blockHash,
        blockNumber: blockNumber - 1,
        logIndex: validators.length + index,
        address: proofRegistry,
        transactionTo: proofRegistry,
      }),
    ),
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
      transactionTo: taskMarket,
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
      transactionTo: taskMarket,
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
        planHash,
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
      issueGateState: {
        termsHash: issueTermsHash.toLowerCase(),
        committedBudget: "0",
        candidates: 0,
        transitionApproved: true,
        matureApproved: false,
      },
      proofRoundState: {
        commitDeadline: "100",
        revealDeadline: "200",
        committed: validators.length,
        revealed: validators.length,
        representedGroups: validators.length,
        minimumGroups: 3,
        validatorRoot: `0x${"2b".repeat(32)}`,
        excludedGroup: `0x${"2c".repeat(32)}`,
        opened: true,
        medianScore: validatorScoreBps,
      },
    },
  ];
  return { rawEvents, stateReads, receiptId, planHash };
}

function normalizedContractPolicy(contracts) {
  const required = [
    "taskMarket",
    "contributionLedger",
    "settlementRouter",
    "proofRegistry",
    "systemIssueGate",
    "transitionIssueConsensus",
    "issueConsensus",
  ];
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
    !ADDRESS_PATTERN.test(rawEvent?.transactionTo?.toLowerCase?.() ?? "") ||
    !Number.isSafeInteger(rawEvent?.blockTimestampMs) ||
    rawEvent.blockTimestampMs < 0 ||
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
  const candidates = CHAIN_EVENT_BY_TOPIC.get(
    rawEvent.topics[0].toLowerCase(),
  );
  if (!candidates) throw new Error("V44_GOVERNANCE_EVENT_UNSUPPORTED");
  const definition = candidates.find(
    (candidate) =>
      rawEvent.address.toLowerCase() === contracts[candidate.contractKey],
  );
  if (!definition) {
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
    transactionTo: rawEvent.transactionTo?.toLowerCase?.() ?? null,
    blockTimestampMs: rawEvent.blockTimestampMs,
    transactionInputHash: sha256Json({
      transactionInput: rawEvent.transactionInput.toLowerCase(),
    }),
    args: jsonSafe(decoded.args),
    finalized: true,
    canonical: true,
  };
  const expectedTransactionTarget =
    definition.type === "TRANSITION_ISSUE_APPROVED"
      ? contracts.transitionIssueConsensus
      : definition.type === "MATURE_ISSUE_APPROVED"
        ? contracts.issueConsensus
        : ["ISSUE_CONSUMED", "ROUND_OPENED", "OUTCOME_RECORDED"].includes(
              definition.type,
            )
          ? contracts.taskMarket
          : contracts[definition.contractKey];
  if (event.transactionTo !== expectedTransactionTarget) {
    throw new Error("V44_GOVERNANCE_TRANSACTION_TARGET_INVALID");
  }
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
  if (definition.type === "MILESTONE_DELIVERED") {
    try {
      const call = decodeFunctionData({
        abi: [DELIVER_ABI],
        data: rawEvent.transactionInput,
      });
      event.deliverInputValid =
        call.functionName === "deliver" &&
        call.args[0].toLowerCase() === event.args.jobId.toLowerCase() &&
        Number(call.args[1]) === Number(event.args.milestone) &&
        call.args[2].toLowerCase() === event.args.deliveryHash.toLowerCase();
    } catch {
      event.deliverInputValid = false;
    }
  }
  if (
    definition.type === "TRANSITION_PROPOSAL_CLOSED" ||
    definition.type === "MATURE_PROPOSAL_CLOSED"
  ) {
    try {
      const call = decodeFunctionData({
        abi: [FINALIZE_ABI],
        data: rawEvent.transactionInput,
      });
      event.finalizeInputValid =
        call.functionName === "finalize" &&
        BigInt(call.args[0]) === BigInt(event.args.proposalId);
    } catch {
      event.finalizeInputValid = false;
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
  providerOperatorId,
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
  if (
    typeof providerOperatorId !== "string" ||
    providerOperatorId.length < 3
  ) {
    throw new Error("V44_GOVERNANCE_RPC_OPERATOR_ID_REQUIRED");
  }
  const providerFinalizedHead = await rpcRequest(
    rpcUrl,
    "eth_getBlockByNumber",
    ["finalized", false],
    fetcher,
  );
  if (
    !providerFinalizedHead ||
    !HASH_PATTERN.test(providerFinalizedHead.hash ?? "") ||
    !providerFinalizedHead.number
  ) {
    throw new Error("V44_GOVERNANCE_FINALIZED_BLOCK_INVALID");
  }
  const providerFinalizedHeadNumber = Number(
    BigInt(providerFinalizedHead.number),
  );
  const evidenceBlockNumber =
    finalizedBlockNumber === undefined
      ? providerFinalizedHeadNumber
      : finalizedBlockNumber;
  if (
    !Number.isSafeInteger(evidenceBlockNumber) ||
    evidenceBlockNumber < fromBlock ||
    evidenceBlockNumber > providerFinalizedHeadNumber
  ) {
    throw new Error("V44_GOVERNANCE_EVIDENCE_BLOCK_NOT_FINALIZED");
  }
  const finalizedBlock =
    evidenceBlockNumber === providerFinalizedHeadNumber
      ? providerFinalizedHead
      : await rpcRequest(
          rpcUrl,
          "eth_getBlockByNumber",
          [rpcQuantity(evidenceBlockNumber), false],
          fetcher,
        );
  if (
    !finalizedBlock ||
    Number(BigInt(finalizedBlock.number)) !== evidenceBlockNumber ||
    !HASH_PATTERN.test(finalizedBlock.hash ?? "")
  ) {
    throw new Error("V44_GOVERNANCE_EVIDENCE_BLOCK_INVALID");
  }
  const resolvedFinalizedBlockNumber = evidenceBlockNumber;
  const readAtEvidenceBlock = async (to, abi, functionName, args = []) =>
    rpcRequest(
      rpcUrl,
      "eth_call",
      [
        {
          to,
          data: encodeFunctionData({ abi, functionName, args }),
        },
        rpcQuantity(resolvedFinalizedBlockNumber),
      ],
      fetcher,
    );
  const [dynamicMaxCandidatesResult, maximumGovernanceMilestonesResult] =
    await Promise.all([
      readAtEvidenceBlock(
        contractPolicy.systemIssueGate,
        SYSTEM_ISSUE_GATE_READ_ABI,
        "dynamicMaxCandidates",
      ),
      readAtEvidenceBlock(
        contractPolicy.taskMarket,
        TASK_MARKET_READ_ABI,
        "MAX_GOVERNANCE_MILESTONES",
      ),
    ]);
  const exposurePolicy = {
    dynamicMaxCandidates: Number(
      decodeAbiParameters(
        [{ type: "uint16" }],
        dynamicMaxCandidatesResult,
      )[0],
    ),
    maximumGovernanceMilestones: Number(
      decodeAbiParameters(
        [{ type: "uint32" }],
        maximumGovernanceMilestonesResult,
      )[0],
    ),
  };
  const logs = await rpcRequest(
    rpcUrl,
    "eth_getLogs",
    [
      {
        address: [
          contractPolicy.taskMarket,
          contractPolicy.contributionLedger,
          contractPolicy.proofRegistry,
          contractPolicy.systemIssueGate,
          contractPolicy.transitionIssueConsensus,
          contractPolicy.issueConsensus,
        ],
        fromBlock: rpcQuantity(fromBlock),
        toBlock: rpcQuantity(resolvedFinalizedBlockNumber),
        topics: [
          [...new Set(CHAIN_EVENT_DEFINITIONS.map((definition) => definition.topic0))],
        ],
      },
    ],
    fetcher,
  );
  const rawEvents = [];
  const blockCache = new Map();
  for (const log of logs) {
    const logBlockNumber = Number(BigInt(log.blockNumber));
    let block = blockCache.get(logBlockNumber);
    if (!block) {
      block = await rpcRequest(
        rpcUrl,
        "eth_getBlockByNumber",
        [rpcQuantity(logBlockNumber), false],
        fetcher,
      );
      blockCache.set(logBlockNumber, block);
    }
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
      blockNumber: logBlockNumber,
      logIndex: Number(BigInt(log.logIndex)),
      address: log.address?.toLowerCase(),
      receiptStatus: receipt?.status === "0x1" ? "success" : "reverted",
      transactionTo: transaction?.to?.toLowerCase() ?? null,
      blockTimestampMs: Number(BigInt(block.timestamp)) * 1_000,
      transactionInput: transaction?.input?.toLowerCase() ?? null,
      topics: (log.topics ?? []).map((topic) => topic.toLowerCase()),
      data: log.data?.toLowerCase(),
    });
  }
  const decodedEvents = rawEvents
    .map((rawEvent) => decodeActualGovernanceRawLog(rawEvent, contractPolicy))
  const lifecycleCandidates = [];
  const candidateKeys = new Set();
  for (const event of decodedEvents) {
    let candidate = null;
    if (["MILESTONE_DELIVERED", "MILESTONE_SETTLED"].includes(event.type)) {
      candidate = {
        jobId: event.args.jobId.toLowerCase(),
        milestone: Number(event.args.milestone),
      };
    } else if (event.type === "JOB_CREATED") {
      candidate = { jobId: event.args.jobId.toLowerCase(), milestone: 0 };
    }
    if (!candidate) continue;
    const key = lifecycleKey(candidate.jobId, candidate.milestone);
    if (!candidateKeys.has(key)) {
      candidateKeys.add(key);
      lifecycleCandidates.push(candidate);
    }
  }
  const stateReads = [];
  for (const event of lifecycleCandidates) {
    const jobId = event.jobId;
    const milestone = event.milestone;
    const call = async (to, abi, functionName, args) =>
      rpcRequest(
        rpcUrl,
        "eth_call",
        [
          {
            to,
            data: encodeFunctionData({
              abi,
              functionName,
              args,
            }),
          },
          rpcQuantity(resolvedFinalizedBlockNumber),
        ],
        fetcher,
      );
    const taskCall = (functionName, args) =>
      call(
        contractPolicy.taskMarket,
        TASK_MARKET_READ_ABI,
        functionName,
        args,
      );
    const [jobResult, milestoneResult, governanceEligibleResult] =
      await Promise.all([
        taskCall("jobs", [jobId]),
        taskCall("milestones", [jobId, milestone]),
        taskCall("jobGovernanceEligible", [jobId]),
      ]);
    const jobOutputs = TASK_MARKET_READ_ABI.find(
      (entry) => entry.name === "jobs",
    ).outputs;
    const milestoneOutputs = TASK_MARKET_READ_ABI.find(
      (entry) => entry.name === "milestones",
    ).outputs;
    const jobValues = decodeAbiParameters(jobOutputs, jobResult);
    const milestoneValues = decodeAbiParameters(milestoneOutputs, milestoneResult);
    const job = Object.fromEntries(
      jobOutputs.map((output, index) => [output.name, jsonSafe(jobValues[index])]),
    );
    for (
      let nextMilestone = 1;
      nextMilestone < Number(job.milestoneCount ?? 0);
      nextMilestone += 1
    ) {
      const nextKey = lifecycleKey(jobId, nextMilestone);
      if (!candidateKeys.has(nextKey)) {
        candidateKeys.add(nextKey);
        lifecycleCandidates.push({ jobId, milestone: nextMilestone });
      }
    }
    const milestoneState = Object.fromEntries(
      milestoneOutputs.map((output, index) => [
        output.name,
        jsonSafe(milestoneValues[index]),
      ]),
    );
    const delivered = decodedEvents.find(
        (candidate) =>
          candidate.type === "MILESTONE_DELIVERED" &&
          candidate.args.jobId.toLowerCase() === jobId &&
          Number(candidate.args.milestone) === milestone,
      );
    const proofRoundId = delivered?.args?.proofRoundId?.toLowerCase() ?? ZERO_HASH;
    const gateOutputs = SYSTEM_ISSUE_GATE_READ_ABI.find(
      (entry) => entry.name === "usage",
    ).outputs;
    const roundOutputs = PROOF_REGISTRY_READ_ABI.find(
      (entry) => entry.name === "rounds",
    ).outputs;
    const [usageResult, roundResult, medianScoreResult] = await Promise.all([
      call(
        contractPolicy.systemIssueGate,
        SYSTEM_ISSUE_GATE_READ_ABI,
        "usage",
        [job.issueId],
      ),
      call(
        contractPolicy.proofRegistry,
        PROOF_REGISTRY_READ_ABI,
        "rounds",
        [proofRoundId],
      ),
      call(
        contractPolicy.proofRegistry,
        PROOF_REGISTRY_READ_ABI,
        "medianScore",
        [proofRoundId],
      ),
    ]);
    const usageValues = decodeAbiParameters(gateOutputs, usageResult);
    const issueTermsHash = usageValues[0].toLowerCase();
    const [transitionApprovedResult, matureApprovedResult] = await Promise.all([
      call(
        contractPolicy.systemIssueGate,
        SYSTEM_ISSUE_GATE_READ_ABI,
        "transitionApprovedIssueHash",
        [issueTermsHash],
      ),
      call(
        contractPolicy.systemIssueGate,
        SYSTEM_ISSUE_GATE_READ_ABI,
        "approvedIssueHash",
        [issueTermsHash],
      ),
    ]);
    const roundValues = decodeAbiParameters(roundOutputs, roundResult);
    stateReads.push({
      jobId,
      milestone,
      finalizedBlockNumber: resolvedFinalizedBlockNumber,
      job,
      milestoneState,
      governanceEligible: decodeAbiParameters(
        [{ type: "bool" }],
        governanceEligibleResult,
      )[0],
      issueGateState: {
        ...Object.fromEntries(
          gateOutputs.map((output, index) => [
            output.name,
            jsonSafe(usageValues[index]),
          ]),
        ),
        transitionApproved: decodeAbiParameters(
          [{ type: "bool" }],
          transitionApprovedResult,
        )[0],
        matureApproved: decodeAbiParameters(
          [{ type: "bool" }],
          matureApprovedResult,
        )[0],
      },
      proofRoundState: {
        ...Object.fromEntries(
          roundOutputs.map((output, index) => [
            output.name,
            jsonSafe(roundValues[index]),
          ]),
        ),
        medianScore: Number(
          decodeAbiParameters([{ type: "uint16" }], medianScoreResult)[0],
        ),
      },
    });
  }
  const origin = new URL(rpcUrl).origin;
  return {
    identity: providerOperatorId,
    providerOperatorId,
    origin,
    finalizedBlockNumber: resolvedFinalizedBlockNumber,
    finalizedBlockHash: finalizedBlock.hash.toLowerCase(),
    providerFinalizedHeadNumber,
    providerFinalizedHeadHash: providerFinalizedHead.hash.toLowerCase(),
    exposurePolicy,
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

function orderedBefore(left, right) {
  return (
    left.blockNumber < right.blockNumber ||
    (left.blockNumber === right.blockNumber && left.logIndex < right.logIndex)
  );
}

function groupedBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const current = groups.get(key) ?? [];
    current.push(value);
    groups.set(key, current);
  }
  return groups;
}

function proposalKey(value) {
  return String(value.args.proposalId);
}

function roundKey(value) {
  return value.args.roundId.toLowerCase();
}

function approvalEvidence(decodedEvents, issueTermsHash) {
  const transitionProposal = decodedEvents.find(
    (event) =>
      event.type === "TRANSITION_ISSUE_PROPOSED" &&
      event.args.issueHash.toLowerCase() === issueTermsHash,
  );
  const matureProposal = decodedEvents.find(
    (event) =>
      event.type === "MATURE_ISSUE_PROPOSED" &&
      event.args.issueHash.toLowerCase() === issueTermsHash,
  );
  const proposal = transitionProposal ?? matureProposal;
  if (!proposal || (transitionProposal && matureProposal)) return null;
  const transition = proposal.type === "TRANSITION_ISSUE_PROPOSED";
  const prefix = transition ? "TRANSITION" : "MATURE";
  const proposalId = proposalKey(proposal);
  const commits = decodedEvents.filter(
    (event) =>
      event.type === `${prefix}_VOTE_COMMITTED` &&
      proposalKey(event) === proposalId,
  );
  const reveals = decodedEvents.filter(
    (event) =>
      event.type === `${prefix}_VOTE_REVEALED` &&
      proposalKey(event) === proposalId,
  );
  const closed = decodedEvents.find(
    (event) =>
      event.type === `${prefix}_PROPOSAL_CLOSED` &&
      proposalKey(event) === proposalId,
  );
  const approved = decodedEvents.find(
    (event) =>
      event.type ===
        (transition
          ? "TRANSITION_ISSUE_APPROVED"
          : "MATURE_ISSUE_APPROVED") &&
      event.args.issueHash.toLowerCase() === issueTermsHash,
  );
  const committedVoters = new Set(
    commits.map((event) => event.args.voter.toLowerCase()),
  );
  const revealedVoters = new Set(
    reveals.map((event) => event.args.voter.toLowerCase()),
  );
  const minimumVoters = transition ? 2 : 5;
  const valid =
    commits.length >= minimumVoters &&
    reveals.length >= minimumVoters &&
    committedVoters.size === commits.length &&
    revealedVoters.size === reveals.length &&
    [...revealedVoters].every((voter) => committedVoters.has(voter)) &&
    reveals.every(
      (event) => event.args.support === true && BigInt(event.args.weight) > 0n,
    ) &&
    closed?.args?.state === 3 &&
    closed?.finalizeInputValid === true &&
    approved?.transactionHash === closed?.transactionHash &&
    approved?.blockHash === closed?.blockHash &&
    orderedBefore(proposal, approved) &&
    commits.every((event) => orderedBefore(proposal, event)) &&
    reveals.every((event) => orderedBefore(event, approved));
  return {
    valid,
    mode: transition ? "TRANSITION" : "MATURE",
    proposalEventId: proposal.eventId,
    proposalBlockNumber: proposal.blockNumber,
    proposalNeedEvidenceHash:
      proposal.args.needEvidenceHash?.toLowerCase?.() ?? null,
    commitEventIds: commits.map((event) => event.eventId).sort(),
    revealEventIds: reveals.map((event) => event.eventId).sort(),
    revealEvidenceHashes: reveals
      .map((event) => event.args.evidenceHash?.toLowerCase?.() ?? null)
      .filter(Boolean),
    approvalEventId: approved?.eventId ?? null,
    approvalBlockNumber: approved?.blockNumber ?? null,
    approvalBlockHash: approved?.blockHash ?? null,
    approvalBlockTimestampMs: approved?.blockTimestampMs ?? null,
    approvalTransactionHash: approved?.transactionHash ?? null,
    approvalLogIndex: approved?.logIndex ?? null,
    closeEventId: closed?.eventId ?? null,
  };
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
  const issueConsumptions = uniqueMap(
    decodedEvents.filter((event) => event.type === "ISSUE_CONSUMED"),
    (event) => event.args.issueId.toLowerCase(),
    "V44_GOVERNANCE_ISSUE_CONSUMED_DUPLICATE",
  );
  const roundOpenings = uniqueMap(
    decodedEvents.filter((event) => event.type === "ROUND_OPENED"),
    roundKey,
    "V44_GOVERNANCE_ROUND_OPENED_DUPLICATE",
  );
  const evaluationCommits = groupedBy(
    decodedEvents.filter((event) => event.type === "EVALUATION_COMMITTED"),
    roundKey,
  );
  const evaluationReveals = groupedBy(
    decodedEvents.filter((event) => event.type === "EVALUATION_REVEALED"),
    roundKey,
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
    const issueId = state?.job?.issueId?.toLowerCase() ?? ZERO_HASH;
    const issueConsumed = issueConsumptions.get(issueId);
    const issueTermsHash =
      state?.issueGateState?.termsHash?.toLowerCase?.() ?? ZERO_HASH;
    const approval = approvalEvidence(decodedEvents, issueTermsHash);
    const roundId = delivered?.args?.proofRoundId?.toLowerCase() ?? ZERO_HASH;
    const roundOpened = roundOpenings.get(roundId);
    const commits = evaluationCommits.get(roundId) ?? [];
    const reveals = evaluationReveals.get(roundId) ?? [];
    const committedValidators = new Set(
      commits.map((event) => event.args.validator.toLowerCase()),
    );
    const revealedValidators = new Set(
      reveals.map((event) => event.args.validator.toLowerCase()),
    );
    const representedGroups = new Set(
      commits.map((event) => event.args.operatorGroup.toLowerCase()),
    );
    const proofRoundState = state?.proofRoundState;
    const minimumReveals = Number(state?.milestoneState?.minimumReveals ?? 0);
    const minimumGroups = Number(proofRoundState?.minimumGroups ?? 0);
    const proofLifecycleValid =
      roundOpened?.transactionHash === delivered?.transactionHash &&
      roundOpened?.blockHash === delivered?.blockHash &&
      orderedBefore(roundOpened, delivered) &&
      roundOpened?.args?.roundId?.toLowerCase() === roundId &&
      roundOpened?.args?.validatorRoot?.toLowerCase() ===
        proofRoundState?.validatorRoot?.toLowerCase?.() &&
      Number(roundOpened?.args?.minimumGroups) === minimumGroups &&
      proofRoundState?.opened === true &&
      commits.length >= minimumReveals &&
      reveals.length >= minimumReveals &&
      committedValidators.size === commits.length &&
      revealedValidators.size === reveals.length &&
      representedGroups.size >= minimumGroups &&
      [...revealedValidators].every((validator) =>
        committedValidators.has(validator),
      ) &&
      Number(proofRoundState?.committed) === commits.length &&
      Number(proofRoundState?.revealed) === reveals.length &&
      Number(proofRoundState?.representedGroups) === representedGroups.size &&
      Number(proofRoundState?.medianScore) >=
        Number(state?.milestoneState?.passScoreBps ?? 10_001) &&
      commits.every((event) => orderedBefore(delivered, event)) &&
      reveals.every(
        (event) => orderedBefore(delivered, event) && orderedBefore(event, settled),
      );
    const funding = Number(state?.job?.funding);
    const chainLifecycleValid =
      [2, 3].includes(funding) &&
      Number(state?.job?.state) === 4 &&
      Number(state?.milestoneState?.state) === 4 &&
      settled.resolveInputValid === true &&
      delivered?.deliverInputValid === true &&
      jobCreated?.args?.issueId?.toLowerCase() ===
        state?.job?.issueId?.toLowerCase() &&
      Number(jobCreated?.args?.funding) === funding &&
      jobCreated?.transactionHash === issueConsumed?.transactionHash &&
      issueConsumed?.args?.proposer?.toLowerCase() ===
        jobCreated?.args?.creator?.toLowerCase() &&
      approval?.valid === true &&
      ((approval.mode === "TRANSITION" &&
        state?.issueGateState?.transitionApproved === true) ||
        (approval.mode === "MATURE" &&
          state?.issueGateState?.matureApproved === true)) &&
      approval.approvalBlockNumber < jobCreated?.blockNumber &&
      proofLifecycleValid &&
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
      issueHash: issueId,
      issueTermsHash,
      jobId,
      milestone,
      roundId: delivered?.args?.proofRoundId?.toLowerCase() ?? ZERO_HASH,
      artifactDigest:
        state?.milestoneState?.deliveryHash?.toLowerCase() ?? ZERO_HASH,
      specificationHash:
        state?.milestoneState?.specificationHash?.toLowerCase() ?? ZERO_HASH,
      jobPlanHash: state?.job?.planHash?.toLowerCase() ?? ZERO_HASH,
      issueApproval: approval,
      jobCreated: jobCreated
        ? {
            eventId: jobCreated.eventId,
            blockNumber: jobCreated.blockNumber,
            blockHash: jobCreated.blockHash,
            blockTimestampMs: jobCreated.blockTimestampMs,
            transactionHash: jobCreated.transactionHash,
            logIndex: jobCreated.logIndex,
          }
        : null,
      validation: {
        roundOpenedEventId: roundOpened?.eventId ?? null,
        roundOpenedBlockNumber: roundOpened?.blockNumber ?? null,
        roundOpenedBlockHash: roundOpened?.blockHash ?? null,
        roundOpenedTransactionHash: roundOpened?.transactionHash ?? null,
        roundOpenedLogIndex: roundOpened?.logIndex ?? null,
        deliveryEventId: delivered?.eventId ?? null,
        commitEventIds: commits.map((event) => event.eventId).sort(),
        revealEventIds: reveals.map((event) => event.eventId).sort(),
        revealEvidenceHashes: reveals.map((event) =>
          event.args.evidenceHash.toLowerCase(),
        ),
        revealScoresBps: reveals.map((event) => Number(event.args.scoreBps)),
        revealEvents: reveals
          .map((event) => ({
            eventId: event.eventId,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            transactionHash: event.transactionHash,
            logIndex: event.logIndex,
          }))
          .sort((left, right) => left.eventId.localeCompare(right.eventId)),
        representedGroups: [...representedGroups].sort(),
        valid: proofLifecycleValid,
      },
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

function deriveGovernanceExposureStates(decodedEvents, stateReads, exposurePolicy) {
  if (
    exposurePolicy?.dynamicMaxCandidates !== 1 ||
    exposurePolicy?.maximumGovernanceMilestones !== 1
  ) {
    throw new Error("V44_GOVERNANCE_EXPOSURE_POLICY_UNSAFE");
  }
  const deliveries = uniqueMap(
    decodedEvents.filter((event) => event.type === "MILESTONE_DELIVERED"),
    (event) => lifecycleKey(event.args.jobId, event.args.milestone),
    "V44_GOVERNANCE_DELIVERY_DUPLICATE",
  );
  const settlements = uniqueMap(
    decodedEvents.filter((event) => event.type === "MILESTONE_SETTLED"),
    (event) => lifecycleKey(event.args.jobId, event.args.milestone),
    "V44_GOVERNANCE_SETTLEMENT_DUPLICATE",
  );
  const outcomes = new Set(
    decodedEvents
      .filter(
        (event) =>
          event.type === "OUTCOME_RECORDED" && event.args.successful === true,
      )
      .map((event) => event.args.receiptId.toLowerCase()),
  );
  const revealsByRound = groupedBy(
    decodedEvents.filter((event) => event.type === "EVALUATION_REVEALED"),
    roundKey,
  );
  const boundIssueTerms = new Set();
  const exposures = [];
  for (const state of stateReads ?? []) {
    if (state.governanceEligible !== true) continue;
    const jobId = state.jobId.toLowerCase();
    const milestone = Number(state.milestone);
    const key = lifecycleKey(jobId, milestone);
    const delivered = deliveries.get(key);
    const settled = settlements.get(key);
    const issueTermsHash =
      state.issueGateState?.termsHash?.toLowerCase?.() ?? ZERO_HASH;
    boundIssueTerms.add(issueTermsHash);
    const roundId = delivered?.args?.proofRoundId?.toLowerCase() ?? ZERO_HASH;
    const reveals = revealsByRound.get(roundId) ?? [];
    const minimumReveals = Number(state.milestoneState?.minimumReveals ?? 0);
    const validatorAuthorized =
      delivered !== undefined &&
      minimumReveals > 0 &&
      reveals.length >= minimumReveals &&
      new Set(reveals.map((event) => event.args.validator.toLowerCase())).size ===
        reveals.length;
    const successfullyConsumed =
      settled !== undefined &&
      outcomes.has(systemSettlementReceiptId(jobId, milestone)) &&
      Number(state.job?.state) === 4 &&
      Number(state.milestoneState?.state) === 4;
    const terminalWithoutSuccess =
      [5, 6, 7].includes(Number(state.job?.state)) ||
      [5, 6].includes(Number(state.milestoneState?.state));
    const stateName = successfullyConsumed
      ? SLOT_STATES.SUCCESSFULLY_CONSUMED
      : terminalWithoutSuccess
        ? SLOT_STATES.TERMINAL_WITHOUT_SUCCESS
      : validatorAuthorized
        ? SLOT_STATES.VALIDATOR_AUTHORIZED
        : delivered !== undefined
          ? SLOT_STATES.VALIDATION_OPEN
          : SLOT_STATES.BOUND_TO_JOB_MILESTONE;
    exposures.push({
      exposureKey: key,
      issueHash: state.job?.issueId?.toLowerCase?.() ?? ZERO_HASH,
      issueTermsHash,
      jobId,
      milestone,
      state: stateName,
      anchors: {
        deliveryEventId: delivered?.eventId ?? null,
        settlementEventId: settled?.eventId ?? null,
        revealEventIds: reveals.map((event) => event.eventId).sort(),
      },
    });
  }
  for (const approved of decodedEvents.filter((event) =>
    ["TRANSITION_ISSUE_APPROVED", "MATURE_ISSUE_APPROVED"].includes(
      event.type,
    ),
  )) {
    const issueTermsHash = approved.args.issueHash.toLowerCase();
    if (boundIssueTerms.has(issueTermsHash)) continue;
    exposures.push({
      exposureKey: `issue:${issueTermsHash}`,
      issueHash: issueTermsHash,
      issueTermsHash,
      jobId: null,
      milestone: null,
      state: SLOT_STATES.RESERVED_FOR_ISSUE,
      anchors: { approvalEventId: approved.eventId },
    });
  }
  return exposures.sort((left, right) =>
    left.exposureKey.localeCompare(right.exposureKey),
  );
}

export function reconcileGovernanceEventSets({
  providers,
  localEventIds,
  contracts,
  providerOperatorPolicy,
}) {
  if (!Array.isArray(providers) || providers.length < 2) {
    return { eligible: false, reason: "TWO_EVENT_PROVIDERS_REQUIRED" };
  }
  const trustedOperators = new Map(
    (providerOperatorPolicy?.providers ?? []).map((provider) => [
      provider.operatorId,
      provider,
    ]),
  );
  if (
    providerOperatorPolicy?.configurationStatus !== "ACTIVE" ||
    trustedOperators.size < 2 ||
    new Set(providers.map((provider) => provider.providerOperatorId)).size < 2 ||
    new Set(providers.map((provider) => provider.origin)).size < 2 ||
    providers.some((provider) => {
      const trusted = trustedOperators.get(provider.providerOperatorId);
      return (
        provider.identity !== provider.providerOperatorId ||
        !trusted ||
        !Array.isArray(trusted.allowedOrigins) ||
        !trusted.allowedOrigins.includes(provider.origin) ||
        typeof trusted.custodyDomainId !== "string" ||
        !HASH_PATTERN.test(trusted.corroborationEvidenceHash ?? "")
      );
    }) ||
    new Set(
      providers.map(
        (provider) =>
          trustedOperators.get(provider.providerOperatorId).custodyDomainId,
      ),
    ).size < 2
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
          first.finalizedBlockHash.toLowerCase() ||
        !Number.isSafeInteger(provider.providerFinalizedHeadNumber) ||
        provider.providerFinalizedHeadNumber < provider.finalizedBlockNumber ||
        !HASH_PATTERN.test(provider.providerFinalizedHeadHash ?? ""),
    )
  ) {
    return { eligible: false, reason: "EVENT_PROVIDER_FINALIZED_HEAD_CONFLICT" };
  }
  const headsByNumber = groupedBy(
    providers,
    (provider) => provider.providerFinalizedHeadNumber,
  );
  if (
    [...headsByNumber.values()].some(
      (sameHeight) =>
        new Set(
          sameHeight.map((provider) =>
            provider.providerFinalizedHeadHash.toLowerCase(),
          ),
        ).size !== 1,
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
  const exposurePolicyRoot = sha256Json(providers[0].exposurePolicy ?? null);
  if (
    providers.some(
      (provider) =>
        sha256Json(provider.exposurePolicy ?? null) !== exposurePolicyRoot,
    )
  ) {
    return { eligible: false, reason: "EVENT_EXPOSURE_POLICY_CONFLICT" };
  }
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
  const exposureStates = deriveGovernanceExposureStates(
    normalizedSets[0],
    normalizedStateReads[0],
    providers[0].exposurePolicy,
  );
  const exposureStateRoot = sha256Json(exposureStates);
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
    exposureStateRoot,
    exposurePolicyRoot,
    exposureStates,
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

export function exposureChainAnchorsForEvent(event) {
  const revealRoot = sha256Json(event.validation?.revealEvents ?? []);
  return [
    {
      kind: "ISSUE_APPROVED",
      eventId: event.issueApproval?.approvalEventId ?? null,
      blockNumber: event.issueApproval?.approvalBlockNumber ?? null,
      blockHash: event.issueApproval?.approvalBlockHash ?? null,
      transactionHash: event.issueApproval?.approvalTransactionHash ?? null,
      logIndex: event.issueApproval?.approvalLogIndex ?? null,
    },
    {
      kind: "JOB_CREATED",
      ...event.jobCreated,
    },
    {
      kind: "PROOF_ROUND_OPENED",
      eventId: event.validation?.roundOpenedEventId ?? null,
      blockNumber: event.validation?.roundOpenedBlockNumber ?? null,
      blockHash: event.validation?.roundOpenedBlockHash ?? null,
      transactionHash: event.validation?.roundOpenedTransactionHash ?? null,
      logIndex: event.validation?.roundOpenedLogIndex ?? null,
    },
    {
      kind: "VALIDATOR_REVEALS",
      evidenceRoot: revealRoot,
      eventCount: event.validation?.revealEvents?.length ?? 0,
    },
    {
      kind: "SYSTEM_SETTLED",
      eventId: event.eventId,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      outcomeEventId: event.outcome?.eventId ?? null,
    },
  ];
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
    const anchors = (journalBySlot.get(slot.slotId) ?? []).map(
      (entry) => entry.chainAnchor,
    );
    const expectedAnchors = event
      ? exposureChainAnchorsForEvent(event)
      : [];
    if (
      event?.issueHash !== slot.issueHash ||
      event?.chainLifecycleValid !== true ||
      states.length !== expectedStates.length ||
      states.some((state, index) => state !== expectedStates[index]) ||
      anchors.some(
        (anchor, index) =>
          sha256Json(anchor) !== sha256Json(expectedAnchors[index]),
      )
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

export function validateExposureLedgerAgainstChainStates(
  ledger,
  exposureStates,
  { maximumExposure = PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS } = {},
) {
  const chainStates = exposureStates ?? [];
  const activeChainStates = chainStates.filter(
    (state) => state.state !== SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  );
  const successfulChainStates = chainStates.filter(
    (state) => state.state === SLOT_STATES.SUCCESSFULLY_CONSUMED,
  );
  if (
    !Number.isSafeInteger(maximumExposure) ||
    maximumExposure < 1 ||
    activeChainStates.length > maximumExposure
  ) {
    throw new Error("V44_CHAIN_EXPOSURE_LIMIT_EXCEEDED");
  }
  const allSlots = Object.values(ledger?.slots ?? {});
  const successfulSlots = allSlots.filter(
    (slot) => slot.state === SLOT_STATES.SUCCESSFULLY_CONSUMED,
  );
  if (
    ledger?.successfulSystemSettlements !== successfulSlots.length ||
    successfulSlots.length !== successfulChainStates.length
  ) {
    throw new Error("V44_CHAIN_EXPOSURE_SUCCESS_COUNTER_MISMATCH");
  }
  if (allSlots.length !== chainStates.length) {
    throw new Error("V44_CHAIN_EXPOSURE_CARDINALITY_MISMATCH");
  }
  const slotsByLifecycle = new Map(
    allSlots
      .filter((slot) => slot.jobId !== null && slot.milestone !== null)
      .map((slot) => [lifecycleKey(slot.jobId, slot.milestone), slot]),
  );
  const unboundSlotsByIssue = groupedBy(
    allSlots.filter((slot) => slot.jobId === null),
    (slot) => slot.issueHash,
  );
  for (const chainState of chainStates) {
    const slot =
      chainState.jobId === null
        ? (unboundSlotsByIssue.get(chainState.issueHash) ?? []).shift()
        : slotsByLifecycle.get(
            lifecycleKey(chainState.jobId, chainState.milestone),
          );
    if (
      !slot ||
      slot.issueHash !== chainState.issueHash ||
      slot.state !== chainState.state
    ) {
      throw new Error("V44_CHAIN_EXPOSURE_STATE_MISMATCH");
    }
  }
  return {
    valid: true,
    exposureCount: activeChainStates.length,
    terminalExposureCount: chainStates.length - activeChainStates.length,
    exposureStateRoot: sha256Json(chainStates),
  };
}

export function deriveSystemSettlementEvidence({
  events,
  exposureStates = null,
  admissionBundles,
  settlementBundles,
  exposureLedger,
  maturityAuthorization = null,
  maturityAuthorizationValidated = false,
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
    const maturityBound =
      maturityAuthorization !== null &&
      maturityAuthorization.authorizedExposureSlotId === slotId &&
      maturityAuthorization.admissionBundleHash === admission?.bundleHash &&
      event.jobPlanHash ===
        maturityAuthorizationPlanHash(maturityAuthorization.authorizationId);
    const admissionBundleValid =
      admission !== undefined &&
      admission.bundleHash === shadowBundleHash(admission) &&
      (
        event.jobPlanHash === admissionBundlePlanHash(admission.bundleHash) ||
        maturityBound
      ) &&
      (
        event.issueApproval?.mode === "MATURE" ||
        (
          event.issueApproval?.mode === "TRANSITION" &&
          event.issueApproval.proposalNeedEvidenceHash === admission.bundleHash &&
          event.issueApproval.revealEvidenceHashes.length >= 2 &&
          event.issueApproval.revealEvidenceHashes.every(
            (evidenceHash) => evidenceHash === admission.bundleHash,
          )
        )
      );
    const settlementBundleValid =
      settlement !== undefined &&
      settlement.bundleHash === shadowBundleHash(settlement) &&
      admission?.sourceSnapshotDigest === settlement?.sourceSnapshotDigest &&
      admission?.exposureSlotId === settlement?.exposureSlotId &&
      event.validation?.valid === true &&
      event.validation.revealEvidenceHashes.length >= 3 &&
      event.validation.revealEvidenceHashes.every(
        (evidenceHash) => evidenceHash === settlement.bundleHash,
      );
    const expectedCanonicalScore =
      admission !== undefined && settlement !== undefined
        ? deterministicValidatorScore(admission.reports, {
            policyVersion: admission.canonicalScorePolicyVersion,
          })
        : -1;
    const canonicalScoreValid =
      admission?.canonicalScorePolicyVersion ===
        settlement?.canonicalScorePolicyVersion &&
      admission?.reports?.[0]?.pass === settlement?.reports?.[0]?.pass &&
      admission !== undefined &&
      settlement !== undefined &&
      expectedCanonicalScore ===
        deterministicValidatorScore(settlement.reports, {
          policyVersion: settlement.canonicalScorePolicyVersion,
        }) &&
      event.validation?.revealScoresBps?.every(
        (scoreBps) => scoreBps === expectedCanonicalScore,
      );
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
  const chainExposure =
    exposureStates === null
      ? null
      : validateExposureLedgerAgainstChainStates(
          exposureLedger,
          exposureStates,
          {
            maximumExposure:
              maturityAuthorizationValidated === true
                ? PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS + 1
                : PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
          },
        );
  return {
    complete,
    events: derivedEvents,
    admissionCount: usedAdmissions.size,
    settlementCount: usedSettlements.size,
    exposureCount: usedSlots.size,
    outcomeCount: usedOutcomes.size,
    exposureLifecycle,
    chainExposure,
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
  governanceExposureRoot = ZERO_HASH,
  rawGovernanceEvidenceRoot = ZERO_HASH,
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
    governanceExposureRoot,
    rawGovernanceEvidenceRoot,
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
    signerBindings = [],
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
  const bindings = validatedSignerBindings(
    authorizedPublicKeys,
    signerBindings,
    threshold,
    "V44_CHECKPOINT_SIGNER_POLICY_INVALID",
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
        !bindings.has(signature.signerKeyId) ||
        signature.signerKeyId !== observerKeyId(signature.publicKeyPem) ||
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
        validSignatures.map(
          (signature) => bindings.get(signature.signerKeyId).controllerDomainId,
        ),
      ).size < threshold ||
      new Set(
        validSignatures.map(
          (signature) => bindings.get(signature.signerKeyId).custodyDomainId,
        ),
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
    providerOperatorPolicy = null,
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
    summary.maximumSuccessfulSystemSettlements !== trustedPreMatureMaximum ||
    summary.declaredSuccessfulSystemSettlements !==
      summary.successfulSystemSettlements
  ) {
    throw new Error("V44_AUTONOMY_EXPOSURE_POLICY_MISMATCH");
  }
  let maturityAuthorization = null;
  const authorizationFlag =
    evidence.exposureLedger.maturityAuthorizationConsumed === true;
  const authorizationProvided = evidence.maturityAuthorization != null;
  if (authorizationFlag !== authorizationProvided) {
    throw new Error("V44_AUTONOMY_MATURITY_AUTHORIZATION_FLAG_MISMATCH");
  }
  if (summary.worstCaseSuccessfulSettlements > trustedPreMatureMaximum) {
    if (
      summary.worstCaseSuccessfulSettlements !== trustedPreMatureMaximum + 1 ||
      !authorizationFlag ||
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
  if (authorizationFlag && maturityAuthorization === null) {
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
    policy.authorizedPublicKeys.length >= policy.threshold &&
    Array.isArray(policy?.signerBindings) &&
    policy.signerBindings.length >= policy.threshold;
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
        signerBindings: controlDomainPolicy?.signerBindings ?? [],
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
    providerOperatorPolicy,
  });
  if (
    admissionBundles.length === 0 ||
    settlementBundles.length === 0 ||
    eventReconciliation.eligible !== true
  ) {
    const checkpoint = validateCheckpointChain(evidence.checkpoints ?? [], {
      authorizedPublicKeys:
        checkpointPolicy?.authorizedPublicKeys ?? [],
      signerBindings: checkpointPolicy?.signerBindings ?? [],
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
  if (maturityAuthorization) {
    const authorizedSlotId =
      evidence.maturityAuthorization.authorizedExposureSlotId;
    const authorizedSlot = evidence.exposureLedger.slots?.[authorizedSlotId];
    const authorizedEvent = eventReconciliation.events.find(
      (event) =>
        event.jobId === authorizedSlot?.jobId &&
        event.milestone === authorizedSlot?.milestone,
    );
    const checkpointIndex = (evidence.checkpoints ?? []).findIndex(
      (checkpoint) =>
        checkpoint.checkpointHash ===
        evidence.maturityAuthorization.precommitCheckpointHash,
    );
    if (checkpointIndex < 0 || !authorizedEvent?.jobCreated) {
      throw new Error("V44_AUTONOMY_MATURITY_PRECOMMIT_MISSING");
    }
    const precommitCheckpoint = evidence.checkpoints[checkpointIndex];
    const precommitChain = validateCheckpointChain(
      evidence.checkpoints.slice(0, checkpointIndex + 1),
      {
        authorizedPublicKeys:
          checkpointPolicy?.authorizedPublicKeys ?? [],
        signerBindings: checkpointPolicy?.signerBindings ?? [],
        threshold: checkpointPolicy?.threshold ?? 2,
      },
    );
    if (
      precommitChain.valid !== true ||
      precommitCheckpoint.finalizedBlockNumber !==
        maturityAuthorization.finalizedBlockNumber ||
      precommitCheckpoint.finalizedBlockHash.toLowerCase() !==
        maturityAuthorization.finalizedBlockHash ||
      precommitCheckpoint.finalizedBlockNumber >=
        authorizedEvent.jobCreated.blockNumber ||
      evidence.maturityAuthorization.issuedAtMs >=
        authorizedEvent.jobCreated.blockTimestampMs ||
      evidence.maturityAuthorization.admissionBundleHash !==
        admissionBundles.find(
          (bundle) => bundle.exposureSlotId === authorizedSlotId,
        )?.bundleHash ||
      authorizedEvent.jobPlanHash !==
        maturityAuthorization.requiredJobPlanHash
    ) {
      throw new Error("V44_AUTONOMY_MATURITY_PRECOMMIT_ORDER_INVALID");
    }
  }
  const settlementEvidence = deriveSystemSettlementEvidence({
    events: eventReconciliation.events,
    exposureStates: eventReconciliation.exposureStates,
    admissionBundles,
    settlementBundles,
    exposureLedger: evidence.exposureLedger,
    maturityAuthorization,
    maturityAuthorizationValidated: maturityAuthorization !== null,
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
    governanceExposureRoot: eventReconciliation.exposureStateRoot,
    rawGovernanceEvidenceRoot: eventReconciliation.rawEvidenceRoot,
  };
  if (generatedCodeCommit) {
    expectedFinalState.generatedCodeCommit = generatedCodeCommit;
  }
  const checkpoint = validateCheckpointChain(evidence.checkpoints ?? [], {
    authorizedPublicKeys:
      checkpointPolicy?.authorizedPublicKeys ?? [],
    signerBindings: checkpointPolicy?.signerBindings ?? [],
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
