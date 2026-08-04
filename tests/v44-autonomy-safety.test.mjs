import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { encodeAbiParameters } from "viem";
import {
  SLOT_STATES,
  collectGovernanceEventSnapshot,
  createControlDomainRegistry,
  createCheckpoint,
  createMaturityAuthorization,
  deriveSystemSettlementEvidence,
  deterministicValidatorScore,
  encodeV44SettlementLifecycleRawLogs,
  exposureChainAnchorsForEvent,
  exposureSlotId,
  exposureSummary,
  gradeControlDomains,
  newExposureLedger,
  reconcileFinalizedProviders,
  reconcileGovernanceEventSets,
  reduceGovernanceContamination,
  reserveExposureSlot,
  sha256Json,
  signControlDomainRegistry,
  signCheckpoint,
  signMaturityAuthorization,
  signObserverReport,
  shadowBundleHash,
  transitionExposureSlot,
  validateCheckpointChain,
  validateControlDomainRegistry,
  validateMaturityAuthorization,
  validateAutonomyEvidence,
  validateExposureLedgerAgainstChainStates,
  validateShadowBundle,
} from "../scripts/lib/v44-autonomy-safety.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const descriptor = (candidateIndex = 0) => ({
  issueHash: hash("1"),
  candidateOperatorGroup: hash("2"),
  objectiveLeaf: hash("3"),
  candidateIndex,
});
const jobId = hash("4");
const taskMarket = `0x${"11".repeat(20)}`;
const contributionLedger = `0x${"12".repeat(20)}`;
const settlementRouter = `0x${"13".repeat(20)}`;
const proofRegistry = `0x${"14".repeat(20)}`;
const systemIssueGate = `0x${"15".repeat(20)}`;
const transitionIssueConsensus = `0x${"16".repeat(20)}`;
const issueConsensus = `0x${"17".repeat(20)}`;
const governanceContracts = {
  taskMarket,
  contributionLedger,
  settlementRouter,
  proofRegistry,
  systemIssueGate,
  transitionIssueConsensus,
  issueConsensus,
};
const providerOperatorPolicy = {
  configurationStatus: "ACTIVE",
  providers: ["a", "b"].map((name) => ({
    operatorId: `rpc-${name}`,
    allowedOrigins: [`https://${name}.example`],
    custodyDomainId: `rpc-custody-${name}`,
    corroborationEvidenceHash: hash(name === "a" ? "a" : "b"),
  })),
};
function governanceProvider(name, value) {
  return {
    identity: `rpc-${name}`,
    providerOperatorId: `rpc-${name}`,
    origin: `https://${name}.example`,
    providerFinalizedHeadNumber: value.finalizedBlockNumber,
    providerFinalizedHeadHash: value.finalizedBlockHash,
    finalizedBlockTimestampMs:
      value.finalizedBlockTimestampMs ?? value.finalizedBlockNumber * 1_000,
    exposurePolicy: {
      dynamicMaxCandidates: 1,
      maximumGovernanceMilestones: 1,
    },
    ...value,
  };
}
const observerKeys = Array.from({ length: 2 }, () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
});

function bundleContext(kind = "ADMISSION") {
  return {
    issueHash: hash("1"),
    sourceSnapshotDigest: hash("2"),
    specificationHash: hash("3"),
    testCommitment: hash("4"),
    revealHash: hash("b"),
    artifactDigest: hash("7"),
    environmentImageDigest: hash("8"),
    roundId: hash("9"),
    jobId,
    milestone: 0,
    replayDomain: kind === "ADMISSION" ? hash("a") : hash("d"),
    exposureSlotId: exposureSlotId(descriptor()),
    commitTimeMs: 2_000,
    canonicalScorePolicyVersion: "EXACT_V1",
  };
}

function signedReports(context, kind = "ADMISSION") {
  return observerKeys.map((keys, index) =>
    signObserverReport(
      {
        schema: "agentpool.v44.shadow-report/v1",
        observerPublicKeyPem: keys.publicKeyPem,
        observerKeyId: null,
        pass: true,
        scoreBps: 9_000,
        evidenceHash: hash(index === 0 ? "5" : "6"),
        controlDomain: `domain-${index}`,
        bundleKind: kind,
        ...context,
        observedAtMs: 1_000,
      },
      keys.privateKeyPem,
    ),
  ).map((report, index) =>
    signObserverReport(
      {
        ...report,
        observerKeyId: sha256Json({
          domain: "AGENTPOOL_V44_OBSERVER_KEY_V1",
          publicKeyPem: observerKeys[index].publicKeyPem.trim(),
        }),
      },
      observerKeys[index].privateKeyPem,
    ),
  );
}

function signedControlRegistry() {
  const unsigned = createControlDomainRegistry({
    issuedAtMs: 500,
    expiresAtMs: 10_000,
    entries: observerKeys.map((keys, index) => ({
      observerKeyId: sha256Json({
        domain: "AGENTPOOL_V44_OBSERVER_KEY_V1",
        publicKeyPem: keys.publicKeyPem.trim(),
      }),
      status: "CORROBORATED",
      anchorEvidenceHash: hash(index === 0 ? "e" : "f"),
      hostDomainId: `host-${index}`,
      controllerDomainId: `domain-${index}`,
    })),
  });
  return observerKeys.reduce(
    (registry, keys, index) =>
      signControlDomainRegistry(registry, {
        ...keys,
        controllerDomain: `registry-controller-${index}`,
      }),
    unsigned,
  );
}

const controlPolicy = {
  authorizedPublicKeys: observerKeys.map((keys) => keys.publicKeyPem),
  signerBindings: observerKeys.map((keys, index) => ({
    signerKeyId: sha256Json({
      domain: "AGENTPOOL_V44_OBSERVER_KEY_V1",
      publicKeyPem: keys.publicKeyPem.trim(),
    }),
    controllerDomainId: `policy-controller-${index}`,
    custodyDomainId: `policy-custody-${index}`,
    corroborationEvidenceHash: hash(index === 0 ? "c" : "d"),
  })),
  threshold: 2,
};

function validatedControlRegistry() {
  return validateControlDomainRegistry(signedControlRegistry(), {
    ...controlPolicy,
    atMs: 2_500,
  });
}

function shadowBundle(kind = "ADMISSION") {
  const context = bundleContext(kind);
  const reports = signedReports(context, kind);
  const bundle = {
    schema:
      kind === "ADMISSION"
        ? "agentpool.v44.shadow-admission/v1"
        : "agentpool.v44.shadow-settlement/v1",
    ...context,
    revealTimeMs: 3_000,
    reports,
    reportRoot: sha256Json(reports),
  };
  return { ...bundle, bundleHash: shadowBundleHash(bundle) };
}

function settlementLifecycle(admission, options = {}) {
  return encodeV44SettlementLifecycleRawLogs({
    transactionHash: options.transactionHash ?? hash("6"),
    blockHash: options.blockHash ?? hash("a"),
    blockNumber: options.blockNumber ?? 100,
    taskMarket,
    contributionLedger,
    settlementRouter,
    proofRegistry,
    systemIssueGate,
    transitionIssueConsensus,
    issueHash: admission.issueHash,
    jobId: admission.jobId,
    milestone: admission.milestone,
    roundId: admission.roundId,
    artifactDigest: admission.artifactDigest,
    specificationHash: admission.specificationHash,
    admissionBundleHash: admission.bundleHash,
    settlementBundleHash:
      options.settlement?.bundleHash ?? `0x${"1a".repeat(32)}`,
  });
}

function completedLedgerFromEvent(event, { anchored = true } = {}) {
  const anchors = anchored
    ? exposureChainAnchorsForEvent(event)
    : Array.from({ length: 5 }, () => null);
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor(), {
    chainAnchor: anchors[0],
  });
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0, chainAnchor: anchors[1] },
  );
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATION_OPEN, {
    chainAnchor: anchors[2],
  });
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATOR_AUTHORIZED, {
    chainAnchor: anchors[3],
  });
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
    {
      descendantFinalized: true,
      terminalOutcome: "SETTLED",
      chainAnchor: anchors[4],
    },
  );
  return ledger;
}

test("unique exposure slots reserve worst-case SYSTEM settlements", () => {
  const ledger = newExposureLedger();
  const slots = Array.from({ length: 49 }, (_, index) =>
    reserveExposureSlot(ledger, descriptor(index)),
  );
  assert.throws(
    () => reserveExposureSlot(ledger, descriptor(49)),
    /V44_EXPOSURE_WORST_CASE_LIMIT/u,
  );
  assert.notEqual(slots[0], slots[1]);
  assert.equal(exposureSummary(ledger).worstCaseSuccessfulSettlements, 49);
});

test("the 50th SYSTEM exposure needs a signed chain-derived one-shot authorization", () => {
  const ledger = newExposureLedger();
  for (let index = 0; index < 49; index += 1) {
    const slotId = reserveExposureSlot(ledger, descriptor(index));
    const uniqueJobId = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    transitionExposureSlot(
      ledger,
      slotId,
      SLOT_STATES.BOUND_TO_JOB_MILESTONE,
      { jobId: uniqueJobId, milestone: 0 },
    );
    transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATION_OPEN);
    transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATOR_AUTHORIZED);
    transitionExposureSlot(
      ledger,
      slotId,
      SLOT_STATES.SUCCESSFULLY_CONSUMED,
      { descendantFinalized: true, terminalOutcome: "SETTLED" },
    );
  }
  const fiftiethDescriptor = descriptor(49);
  const fiftiethSlotId = exposureSlotId(fiftiethDescriptor);
  const snapshot = {
    successfulSystemSettlements: 49,
    governanceSnapshotEpoch: 1,
    nonMaintainerVotingAgents: Array.from({ length: 6 }, (_, index) => ({
      agent: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      operatorGroup: `0x${((index % 3) + 1).toString(16).padStart(64, "0")}`,
      controlDomain: `domain-${index}`,
      workPower: "20",
    })),
    maintainerGovernanceUnits: "0",
    proposalBondAvailable: true,
    recoveryIssueAvailable: true,
    unresolvedCriticalHigh: 0,
    governanceDryRunPassed: true,
  };
  const chainSnapshot = {
    successfulSystemSettlements: 49,
    governanceSnapshotEpoch: 1,
    eligibleAgentCount: 6,
    eligibleGroupCount: 3,
    populationComplete: true,
    populationFromBlock: 1,
    populationToBlock: 100,
    populationSourceEventCount: 49,
    successfulAgentAddressCount: 6,
    positiveVotingAgentCount: 6,
    positiveVotingGroupCount: 3,
    votingAgents: snapshot.nonMaintainerVotingAgents.map(
      ({ agent, operatorGroup, workPower }) => ({
        agent: agent.toLowerCase(),
        operatorGroup,
        workPower,
      }),
    ),
  };
  chainSnapshot.totalWorkPower = chainSnapshot.votingAgents
    .reduce((total, agent) => total + BigInt(agent.workPower), 0n)
    .toString();
  chainSnapshot.populationRoot = sha256Json(chainSnapshot.votingAgents);
  const readinessEvidence = {
    proposalBond: {
      token: `0x${"91".repeat(20)}`,
      owner: `0x${"92".repeat(20)}`,
      spender: `0x${"93".repeat(20)}`,
      requiredAmount: "100",
      onchainMinimumBond: "100",
      balance: "100",
      allowance: "100",
      blockNumber: 100,
      evidenceHash: hash("9"),
    },
    recoveryIssue: {
      issueId: hash("a"),
      state: "AVAILABLE",
      evidenceHash: hash("b"),
    },
    governanceDryRun: {
      transcriptHash: hash("e"),
      verifierVersion: "v44-dry-run-v1",
      passed: true,
    },
    incidentLedger: { root: hash("f"), unresolvedCriticalHigh: 0 },
    maintainerWorkPower: {
      agentSetRoot: hash("1"),
      epoch: 1,
      units: "0",
    },
  };
  const unsigned = createMaturityAuthorization({
    issuedAtMs: 2_000,
    expiresAtMs: 10_000,
    sourceCommit: "a".repeat(40),
    deploymentManifestSha256: "b".repeat(64),
    authorizedExposureSlotId: fiftiethSlotId,
    admissionBundleHash: hash("c"),
    precommitCheckpointHash: hash("d"),
    providerSnapshots: [
      {
        identity: "rpc-a",
        providerOperatorId: "rpc-a",
        origin: "https://a.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: hash("a"),
        snapshot,
        chainSnapshot,
      },
      {
        identity: "rpc-b",
        providerOperatorId: "rpc-b",
        origin: "https://b.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: hash("a"),
        snapshot,
        chainSnapshot,
      },
    ],
    readinessEvidence,
  });
  const authorization = observerKeys.reduce(
    (value, keys, index) =>
      signMaturityAuthorization(value, {
        ...keys,
        controllerDomain: `maturity-controller-${index}`,
      }),
    unsigned,
  );
  const policy = {
    authorizedPublicKeys: observerKeys.map((keys) => keys.publicKeyPem),
    signerBindings: controlPolicy.signerBindings,
    agentControlDomainBindings: snapshot.nonMaintainerVotingAgents.map(
      (agent, index) => ({
        agent: agent.agent,
        controllerDomainId: `agent-controller-${index}`,
        custodyDomainId: `agent-custody-${index}`,
        corroborationEvidenceHash: hash(index % 2 === 0 ? "7" : "8"),
      }),
    ),
    threshold: 2,
    expectedSourceCommit: "a".repeat(40),
    expectedDeploymentManifestSha256: "b".repeat(64),
    trustedProviderSnapshots: unsigned.providerSnapshots.map((provider) => ({
      identity: provider.identity,
      origin: provider.origin,
      finalizedBlockNumber: provider.finalizedBlockNumber,
      finalizedBlockHash: provider.finalizedBlockHash,
      chainSnapshot: provider.chainSnapshot,
    })),
    trustedReadinessEvidence: readinessEvidence,
    trustedMaturityPublication: {
      authorizationId: `0x${authorization.authorizationId}`,
      precommitCheckpointHash: authorization.precommitCheckpointHash,
      exposureSlotId: authorization.authorizedExposureSlotId,
      admissionBundleHash: authorization.admissionBundleHash,
      evidencePipelineCommit: `0x${authorization.sourceCommit}`,
      deploymentManifestHash: `0x${authorization.deploymentManifestSha256}`,
      blockNumber: 99,
      blockHash: hash("8"),
      transactionHash: hash("7"),
    },
    providerOperatorPolicy,
  };
  assert.equal(
    validateMaturityAuthorization(authorization, {
      ...policy,
      atMs: 2_500,
      expectedExposureSlotId: fiftiethSlotId,
    }).valid,
    true,
  );
  assert.throws(
    () =>
      validateMaturityAuthorization(authorization, {
        ...policy,
        atMs: 2_500,
        expectedExposureSlotId: fiftiethSlotId,
        trustedReadinessEvidence: {
          ...readinessEvidence,
          proposalBond: {
            ...readinessEvidence.proposalBond,
            balance: "0",
          },
        },
      }),
    /V44_MATURITY_READINESS_EVIDENCE_INVALID/u,
  );
  const omittedSnapshots = structuredClone(unsigned.providerSnapshots);
  for (const provider of omittedSnapshots) {
    provider.snapshot.nonMaintainerVotingAgents =
      provider.snapshot.nonMaintainerVotingAgents.slice(1);
    provider.chainSnapshot.votingAgents =
      provider.chainSnapshot.votingAgents.slice(1);
    provider.chainSnapshot.positiveVotingAgentCount = 5;
    provider.chainSnapshot.totalWorkPower = "100";
    provider.chainSnapshot.populationRoot = sha256Json(
      provider.chainSnapshot.votingAgents,
    );
  }
  const omittedUnsigned = createMaturityAuthorization({
    ...unsigned,
    providerSnapshots: omittedSnapshots,
  });
  const omittedAuthorization = observerKeys.reduce(
    (value, keys, index) =>
      signMaturityAuthorization(value, {
        ...keys,
        controllerDomain: `maturity-controller-${index}`,
      }),
    omittedUnsigned,
  );
  assert.throws(
    () =>
      validateMaturityAuthorization(omittedAuthorization, {
        ...policy,
        trustedMaturityPublication: {
          ...policy.trustedMaturityPublication,
          authorizationId: `0x${omittedAuthorization.authorizationId}`,
        },
        atMs: 2_500,
        expectedExposureSlotId: fiftiethSlotId,
      }),
    /V44_MATURITY_CHAIN_SNAPSHOT_NOT_CORROBORATED/u,
  );
  reserveExposureSlot(ledger, fiftiethDescriptor, {
    maturityAuthorization: authorization,
    maturityAuthorizationPolicy: policy,
    evaluationTimeMs: 2_500,
  });
  assert.equal(exposureSummary(ledger).worstCaseSuccessfulSettlements, 50);
  assert.equal(ledger.maturityAuthorizationConsumed, true);
  assert.throws(
    () =>
      reserveExposureSlot(ledger, descriptor(50), {
        maturityAuthorization: authorization,
        maturityAuthorizationPolicy: policy,
        evaluationTimeMs: 2_500,
      }),
    /V44_EXPOSURE_WORST_CASE_LIMIT/u,
  );
});

test("Issue expiry cannot release a slot with a live descendant", () => {
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor());
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0 },
  );
  assert.throws(
    () =>
      transitionExposureSlot(
        ledger,
        slotId,
        SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
        { issueExpired: true },
      ),
    /V44_EXPOSURE_TERMINAL_NOT_FINAL/u,
  );
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
    { descendantFinalized: true, terminalOutcome: "REFUNDED" },
  );
  assert.equal(exposureSummary(ledger).liveExposure, 0);
});

test("successful exposure is consumed exactly once", () => {
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor());
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0 },
  );
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATION_OPEN);
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.VALIDATOR_AUTHORIZED,
  );
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
    { descendantFinalized: true, terminalOutcome: "SETTLED" },
  );
  assert.equal(ledger.successfulSystemSettlements, 1);
  assert.throws(
    () =>
      transitionExposureSlot(
        ledger,
        slotId,
        SLOT_STATES.SUCCESSFULLY_CONSUMED,
        { descendantFinalized: true, terminalOutcome: "SETTLED" },
      ),
    /V44_EXPOSURE_SLOT_TRANSITION_INVALID/u,
  );
});

test("admission and settlement shadow bundles bind commit reveal evidence", () => {
  const bundle = shadowBundle();
  assert.equal(
    validateShadowBundle(bundle, {
      kind: "ADMISSION",
      controlDomainRegistry: validatedControlRegistry(),
    }),
    bundle,
  );
  bundle.reports[0].scoreBps = 9_999;
  assert.throws(
    () =>
      validateShadowBundle(bundle, {
        kind: "ADMISSION",
        controlDomainRegistry: validatedControlRegistry(),
      }),
    /SIGNATURE_INVALID/u,
  );
});

test("one observer key cannot impersonate two control domains", () => {
  const bundle = shadowBundle();
  bundle.reports = [bundle.reports[0], structuredClone(bundle.reports[0])];
  bundle.reportRoot = sha256Json(bundle.reports);
  bundle.bundleHash = shadowBundleHash(bundle);
  assert.throws(
    () =>
      validateShadowBundle(bundle, {
        kind: "ADMISSION",
        controlDomainRegistry: validatedControlRegistry(),
      }),
    /OBSERVER_KEY_REUSED/u,
  );
});

test("observer signatures cannot replay across Issue context", () => {
  const bundle = shadowBundle();
  bundle.issueHash = hash("f");
  bundle.bundleHash = shadowBundleHash(bundle);
  assert.throws(
    () =>
      validateShadowBundle(bundle, {
        kind: "ADMISSION",
        controlDomainRegistry: validatedControlRegistry(),
      }),
    /ISSUEHASH_MISMATCH/u,
  );
});

test("validator score is deterministic and declared groups are not independence", () => {
  const reports = [
    {
      scoreBps: 8_000,
      controlEvidence: {
        status: "VERIFIED",
        hostFingerprint: "host-a",
        controllerFingerprint: "controller-one",
      },
    },
    {
      scoreBps: 7_000,
      controlEvidence: {
        status: "VERIFIED",
        hostFingerprint: "host-b",
        controllerFingerprint: "controller-one",
      },
    },
    {
      scoreBps: 9_000,
      controlEvidence: {
        status: "VERIFIED",
        hostFingerprint: "host-c",
        controllerFingerprint: "controller-one",
      },
    },
  ];
  assert.equal(
    deterministicValidatorScore(reports, { policyVersion: "MEDIAN_V1" }),
    8_000,
  );
  assert.throws(
    () => deterministicValidatorScore(reports),
    /V44_VALIDATOR_EXACT_MISMATCH/u,
  );
  assert.equal(gradeControlDomains(reports).grade, "UNVERIFIED");
});

test("finality reconciliation rejects stale, conflicting, and aliased providers", () => {
  const nowMs = Date.parse("2026-07-30T00:10:00Z");
  const provider = {
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("8"),
    latestBlockNumber: 110,
    finalizedTimestampMs: Date.parse("2026-07-30T00:09:00Z"),
  };
  assert.equal(
    reconcileFinalizedProviders(
      [
        { ...provider, identity: "a", origin: "https://a.example" },
        { ...provider, identity: "b", origin: "https://b.example" },
      ],
      { nowMs },
    ).eligible,
    true,
  );
  assert.equal(
    reconcileFinalizedProviders(
      [
        { ...provider, identity: "same", origin: "https://a.example" },
        { ...provider, identity: "same", origin: "https://b.example" },
      ],
      { nowMs },
    ).reason,
    "PROVIDER_INDEPENDENCE_UNPROVEN",
  );
  assert.equal(
    reconcileFinalizedProviders(
      [
        { ...provider, identity: "a", origin: "https://a.example" },
        {
          ...provider,
          finalizedBlockHash: hash("9"),
          identity: "b",
          origin: "https://b.example",
        },
      ],
      { nowMs },
    ).reason,
    "FINALIZED_HEAD_CONFLICT",
  );
});

test("only finalized canonical invalid SYSTEM settlement contaminates governance", () => {
  const invalid = {
    eventId: "event-1",
    type: "SYSTEM_SETTLED",
    blockNumber: 10,
    logIndex: 0,
    finalized: false,
    canonical: true,
    admissionBundleValid: false,
  };
  assert.equal(
    reduceGovernanceContamination([invalid]).governanceContaminated,
    false,
  );
  invalid.finalized = true;
  assert.equal(
    reduceGovernanceContamination([invalid]).governanceContaminated,
    true,
  );
  invalid.canonical = false;
  assert.equal(
    reduceGovernanceContamination([invalid]).governanceContaminated,
    false,
  );
});

test("checkpoint deletion, mutation, and chain breaks are detected", () => {
  const zero = hash("0");
  const first = createCheckpoint({
    previousCheckpointHash: zero,
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("a"),
    exposureLedgerRoot: hash("b"),
    admissionBundleRoot: hash("c"),
    settlementBundleRoot: hash("d"),
    contaminationLatch: false,
    incidentRoot: hash("e"),
    generatedCodeCommit: hash("f"),
  });
  const signedFirst = observerKeys.reduce(
    (checkpoint, keys, index) =>
      signCheckpoint(checkpoint, {
        ...keys,
        controllerDomain: `controller-${index}`,
      }),
    first,
  );
  const second = createCheckpoint({
    previousCheckpointHash: signedFirst.checkpointHash,
    finalizedBlockNumber: 101,
    finalizedBlockHash: hash("1"),
    exposureLedgerRoot: hash("2"),
    admissionBundleRoot: hash("3"),
    settlementBundleRoot: hash("4"),
    contaminationLatch: false,
    incidentRoot: hash("5"),
    generatedCodeCommit: hash("6"),
  });
  const signedSecond = observerKeys.reduce(
    (checkpoint, keys, index) =>
      signCheckpoint(checkpoint, {
        ...keys,
        controllerDomain: `controller-${index}`,
      }),
    second,
  );
  const policy = {
    ...controlPolicy,
  };
  assert.equal(
    validateCheckpointChain([signedFirst, signedSecond], policy).valid,
    true,
  );
  assert.throws(
    () => validateCheckpointChain([signedSecond], policy),
    /V44_CHECKPOINT_CHAIN_BROKEN/u,
  );
  const changed = structuredClone(signedSecond);
  changed.finalizedBlockHash = hash("7");
  assert.throws(
    () => validateCheckpointChain([signedFirst, changed], policy),
    /V44_CHECKPOINT_HASH_INVALID/u,
  );
  assert.equal(
    validateCheckpointChain([], policy).status,
    "PENDING_NO_CHECKPOINT",
  );
  assert.throws(
    () =>
      validateCheckpointChain([signedFirst, signedSecond], {
        ...policy,
        expectedFinalState: { exposureLedgerRoot: hash("f") },
      }),
    /FINAL_STATE_MISMATCH/u,
  );
});

test("exposure slot identity includes candidate and objective boundaries", () => {
  assert.notEqual(
    exposureSlotId(descriptor(0)),
    exposureSlotId(descriptor(1)),
  );
});

test("empty autonomy evidence remains pending instead of becoming ready", () => {
  const evidence = {
    schema: "agentpool.v44.autonomy-evidence/v1",
    exposureLedger: newExposureLedger(),
    admissionBundles: [],
    settlementBundles: [],
    governanceEventIds: [],
    governanceEventProviders: [],
    checkpoints: [],
    checkpointPolicy: { authorizedPublicKeys: [], threshold: 2 },
  };
  const result = validateAutonomyEvidence(evidence);
  assert.equal(result.valid, false);
  assert.equal(result.status, "PENDING_NO_EVIDENCE");
  const forgedCounter = structuredClone(evidence);
  forgedCounter.exposureLedger.successfulSystemSettlements = 49;
  assert.throws(
    () => validateAutonomyEvidence(forgedCounter),
    /V44_AUTONOMY_EXPOSURE_POLICY_MISMATCH/u,
  );
  const forgedAuthorizationFlag = structuredClone(evidence);
  forgedAuthorizationFlag.exposureLedger.maturityAuthorizationConsumed = true;
  forgedAuthorizationFlag.exposureLedger.maturityAuthorizationId = hash("9");
  assert.throws(
    () => validateAutonomyEvidence(forgedAuthorizationFlag),
    /V44_AUTONOMY_MATURITY_AUTHORIZATION_FLAG_MISMATCH/u,
  );
});

test("provider event sets must agree with the complete local ledger", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 10 });
  const eventId = `${hash("6")}:1`;
  const providers = [
    governanceProvider("a", {
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      rawEvents: lifecycle.rawEvents,
      stateReads: lifecycle.stateReads,
    }),
    governanceProvider("b", {
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      rawEvents: lifecycle.rawEvents,
      stateReads: lifecycle.stateReads,
    }),
  ];
  assert.equal(
    reconcileGovernanceEventSets({
      providers,
      localEventIds: [eventId],
      contracts: governanceContracts,
      providerOperatorPolicy,
    }).eligible,
    true,
  );
  assert.equal(
    reconcileGovernanceEventSets({
      providers,
      localEventIds: [],
      contracts: governanceContracts,
      providerOperatorPolicy,
    }).reason,
    "LOCAL_EVENT_SET_INCOMPLETE",
  );
});

test("unsettled governance exposure is counted before settlement", () => {
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor());
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0 },
  );
  assert.equal(
    validateExposureLedgerAgainstChainStates(ledger, [
      {
        exposureKey: `${jobId}:0`,
        issueHash: hash("1"),
        issueTermsHash: hash("1"),
        jobId,
        milestone: 0,
        state: SLOT_STATES.BOUND_TO_JOB_MILESTONE,
        anchors: {},
      },
    ]).exposureCount,
    1,
  );
  assert.throws(
    () =>
      validateExposureLedgerAgainstChainStates(
        ledger,
        Array.from({ length: 50 }, (_, index) => ({
          exposureKey: `issue:${index}`,
          issueHash: hash("1"),
          issueTermsHash: hash("1"),
          jobId: null,
          milestone: null,
          state: SLOT_STATES.RESERVED_FOR_ISSUE,
          anchors: {},
        })),
      ),
    /V44_CHAIN_EXPOSURE_LIMIT_EXCEEDED/u,
  );
});

test("an approved unconsumed Issue stops reserving capacity after its onchain expiry", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 100 });
  const approvedIssueEvents = lifecycle.rawEvents.slice(0, 7);
  const reconcileAt = (finalizedBlockTimestampMs) =>
    reconcileGovernanceEventSets({
      providers: ["a", "b"].map((name) =>
        governanceProvider(name, {
          finalizedBlockNumber: 100,
          finalizedBlockHash: hash("a"),
          finalizedBlockTimestampMs,
          rawEvents: approvedIssueEvents,
          stateReads: [],
        }),
      ),
      localEventIds: [],
      contracts: governanceContracts,
      providerOperatorPolicy,
    });
  const beforeExpiry = reconcileAt(50_000_000);
  assert.equal(beforeExpiry.exposureStates.length, 1);
  assert.equal(
    beforeExpiry.exposureStates[0].state,
    SLOT_STATES.RESERVED_FOR_ISSUE,
  );
  const afterExpiry = reconcileAt(90_000_000);
  assert.equal(afterExpiry.exposureStates.length, 1);
  assert.equal(
    afterExpiry.exposureStates[0].state,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
  );
});

test("finalized failed work releases active exposure without deleting history", () => {
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor());
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0 },
  );
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
    { descendantFinalized: true, terminalOutcome: "REFUNDED" },
  );
  const result = validateExposureLedgerAgainstChainStates(ledger, [
    {
      exposureKey: `${jobId}:0`,
      issueHash: hash("1"),
      issueTermsHash: hash("1"),
      jobId,
      milestone: 0,
      state: SLOT_STATES.TERMINAL_WITHOUT_SUCCESS,
      anchors: {},
    },
  ]);
  assert.equal(result.exposureCount, 0);
  assert.equal(result.terminalExposureCount, 1);
});

test("multi-candidate or multi-milestone governance policy fails closed", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 10 });
  const providers = ["a", "b"].map((name) =>
    governanceProvider(name, {
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      exposurePolicy: {
        dynamicMaxCandidates: 3,
        maximumGovernanceMilestones: 1,
      },
      rawEvents: lifecycle.rawEvents,
      stateReads: lifecycle.stateReads,
    }),
  );
  assert.throws(
    () =>
      reconcileGovernanceEventSets({
        providers,
        localEventIds: [`${hash("6")}:1`],
        contracts: governanceContracts,
        providerOperatorPolicy,
      }),
    /V44_GOVERNANCE_EXPOSURE_POLICY_UNSAFE/u,
  );
});

test("two RPCs expose a delivered but unsettled SYSTEM milestone", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 10 });
  const rawEvents = lifecycle.rawEvents.filter(
    (event) =>
      event.address !== contributionLedger &&
      !(
        event.address === taskMarket &&
        event.logIndex === 1 &&
        event.blockNumber === 10
      ),
  );
  const stateReads = structuredClone(lifecycle.stateReads);
  stateReads[0].job.state = 2;
  stateReads[0].milestoneState.state = 2;
  const providers = ["a", "b"].map((name) =>
    governanceProvider(name, {
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      rawEvents,
      stateReads,
    }),
  );
  const reconciled = reconcileGovernanceEventSets({
    providers,
    localEventIds: [],
    contracts: governanceContracts,
    providerOperatorPolicy,
  });
  assert.equal(reconciled.eligible, true);
  assert.equal(reconciled.events.length, 0);
  assert.equal(reconciled.exposureStates.length, 1);
  assert.equal(
    reconciled.exposureStates[0].state,
    SLOT_STATES.VALIDATOR_AUTHORIZED,
  );
});

test("a provider cannot claim an evidence block above its own finalized head", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 10 });
  const providers = ["a", "b"].map((name) =>
    governanceProvider(name, {
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      providerFinalizedHeadNumber: name === "a" ? 10 : 9,
      providerFinalizedHeadHash: hash("a"),
      rawEvents: lifecycle.rawEvents,
      stateReads: lifecycle.stateReads,
    }),
  );
  assert.equal(
    reconcileGovernanceEventSets({
      providers,
      localEventIds: [`${hash("6")}:1`],
      contracts: governanceContracts,
      providerOperatorPolicy,
    }).reason,
    "EVENT_PROVIDER_FINALIZED_HEAD_CONFLICT",
  );
});

test("a unique nonzero fake outcome receipt cannot satisfy settlement evidence", () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission, { blockNumber: 10 });
  const forged = structuredClone(lifecycle.rawEvents);
  forged.find((event) => event.address === contributionLedger).topics[3] =
    hash("e");
  const providers = ["a", "b"].map((name) => governanceProvider(name, {
    finalizedBlockNumber: 10,
    finalizedBlockHash: hash("a"),
    rawEvents: forged,
    stateReads: lifecycle.stateReads,
  }));
  const result = reconcileGovernanceEventSets({
    providers,
    localEventIds: [`${hash("6")}:1`],
    contracts: governanceContracts,
    providerOperatorPolicy,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.events[0].chainLifecycleValid, false);
  assert.equal(result.events[0].outcome, null);
});

test("governance snapshots are collected from raw finalized RPC evidence", async () => {
  const admission = shadowBundle("ADMISSION");
  const lifecycle = settlementLifecycle(admission);
  const rawByTransaction = new Map(
    lifecycle.rawEvents.map((event) => [event.transactionHash, event]),
  );
  const jobState = lifecycle.stateReads[0].job;
  const milestoneState = lifecycle.stateReads[0].milestoneState;
  const issueGateState = lifecycle.stateReads[0].issueGateState;
  const proofRoundState = lifecycle.stateReads[0].proofRoundState;
  const jobResult = encodeAbiParameters(
    [
      "address", "uint8", "uint8", "bytes32", "bytes32", "bytes32",
      "uint128", "uint128", "uint32", "uint32", "uint64",
    ].map((type) => ({ type })),
    [
      jobState.creator, jobState.funding, jobState.state, jobState.planHash,
      jobState.releaseId, jobState.issueId, BigInt(jobState.budget),
      BigInt(jobState.paid), jobState.nextMilestone, jobState.milestoneCount,
      BigInt(jobState.createdAt),
    ],
  );
  const milestoneResult = encodeAbiParameters(
    [
      "address", "address", "bytes32", "bytes32", "bytes32", "bytes32",
      "bytes32", "uint128", "uint128", "uint128", "uint64", "uint32",
      "uint16", "uint16", "uint32", "uint32", "uint8", "bool", "bool",
    ].map((type) => ({ type })),
    [
      milestoneState.worker, milestoneState.verifier, milestoneState.capability,
      milestoneState.specificationHash, milestoneState.expectedEvidenceHash,
      milestoneState.payoutRoot, milestoneState.deliveryHash,
      BigInt(milestoneState.allocation), BigInt(milestoneState.workerBond),
      BigInt(milestoneState.keeperFee), BigInt(milestoneState.deadline),
      milestoneState.capacityUnits, milestoneState.minimumReveals,
      milestoneState.passScoreBps, milestoneState.commitWindow,
      milestoneState.revealWindow, milestoneState.state,
      milestoneState.candidateAttested, milestoneState.adoptionRecorded,
    ],
  );
  const ethCallResults = [
    encodeAbiParameters([{ type: "uint16" }], [1]),
    encodeAbiParameters([{ type: "uint32" }], [1]),
    jobResult,
    milestoneResult,
    encodeAbiParameters([{ type: "bool" }], [true]),
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint128" }, { type: "uint16" }],
      [
        issueGateState.termsHash,
        BigInt(issueGateState.committedBudget),
        issueGateState.candidates,
      ],
    ),
    encodeAbiParameters(
      [
        "uint64", "uint64", "uint16", "uint16", "uint16", "uint16",
        "bytes32", "bytes32", "bool",
      ].map((type) => ({ type })),
      [
        BigInt(proofRoundState.commitDeadline),
        BigInt(proofRoundState.revealDeadline),
        proofRoundState.committed,
        proofRoundState.revealed,
        proofRoundState.representedGroups,
        proofRoundState.minimumGroups,
        proofRoundState.validatorRoot,
        proofRoundState.excludedGroup,
        proofRoundState.opened,
      ],
    ),
    encodeAbiParameters(
      [{ type: "uint16" }],
      [proofRoundState.medianScore],
    ),
    encodeAbiParameters([{ type: "bool" }], [true]),
    encodeAbiParameters([{ type: "bool" }], [false]),
  ];
  const replies = {
    eth_chainId: "0x14a34",
    eth_getBlockByNumber: {
      number: "0x64",
      hash: hash("a"),
      timestamp: "0x64",
    },
    eth_getLogs: lifecycle.rawEvents.map((event) => ({
      ...event,
      blockNumber: `0x${event.blockNumber.toString(16)}`,
      logIndex: `0x${event.logIndex.toString(16)}`,
    })),
    eth_getTransactionReceipt: { status: "0x1" },
  };
  const snapshot = await collectGovernanceEventSnapshot({
    rpcUrl: "https://rpc-a.example/v1/key",
    providerOperatorId: "rpc-a",
    fromBlock: 1,
    contracts: governanceContracts,
    fetcher: async (_url, options) => {
      const request = JSON.parse(options.body);
      let result = replies[request.method];
      if (request.method === "eth_getTransactionByHash") {
        const raw = rawByTransaction.get(request.params[0].toLowerCase());
        result = {
          input: raw?.transactionInput ?? "0x",
          to: raw?.transactionTo ?? taskMarket,
        };
      }
      if (request.method === "eth_call") result = ethCallResults.shift();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(snapshot.origin, "https://rpc-a.example");
  assert.equal(snapshot.finalizedBlockNumber, 100);
  assert.equal(snapshot.rawEvents.length, lifecycle.rawEvents.length);
  assert.equal(snapshot.stateReads.length, 1);
  assert.equal(snapshot.stateReads[0].governanceEligible, true);
});

test("a shadow bundle written after settlement cannot impersonate onchain validator reveals", () => {
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const lifecycle = settlementLifecycle(admission);
  const providers = ["a", "b"].map((name) => governanceProvider(name, {
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("a"),
    rawEvents: lifecycle.rawEvents,
    stateReads: lifecycle.stateReads,
  }));
  const reconciled = reconcileGovernanceEventSets({
    providers,
    localEventIds: [`${hash("6")}:1`],
    contracts: governanceContracts,
    providerOperatorPolicy,
  });
  assert.equal(reconciled.eligible, true);
  const ledger = completedLedgerFromEvent(reconciled.events[0]);
  const result = deriveSystemSettlementEvidence({
    events: reconciled.events,
    admissionBundles: [admission],
    settlementBundles: [settlement],
    exposureLedger: ledger,
  });
  assert.equal(result.complete, false);
  assert.equal(result.events[0].settlementBundleValid, false);
});

test("a posthoc journal without exact chain anchors is rejected", () => {
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const lifecycle = settlementLifecycle(admission, { settlement });
  const providers = ["a", "b"].map((name) => governanceProvider(name, {
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("a"),
    rawEvents: lifecycle.rawEvents,
    stateReads: lifecycle.stateReads,
  }));
  const reconciled = reconcileGovernanceEventSets({
    providers,
    localEventIds: [`${hash("6")}:1`],
    contracts: governanceContracts,
    providerOperatorPolicy,
  });
  const ledger = completedLedgerFromEvent(reconciled.events[0], {
    anchored: false,
  });
  assert.throws(
    () =>
      deriveSystemSettlementEvidence({
        events: reconciled.events,
        admissionBundles: [admission],
        settlementBundles: [settlement],
        exposureLedger: ledger,
      }),
    /V44_EXPOSURE_JOURNAL_CHAIN_LIFECYCLE_MISMATCH/u,
  );
});

test("complete independently signed evidence can reach VERIFIED", () => {
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const transactionHash = hash("6");
  const lifecycle = settlementLifecycle(admission, {
    transactionHash,
    settlement,
  });
  const eventId = `${transactionHash}:1`;
  const providers = ["a", "b"].map((name) => governanceProvider(name, {
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("a"),
    rawEvents: lifecycle.rawEvents,
    stateReads: lifecycle.stateReads,
  }));
  const reconciled = reconcileGovernanceEventSets({
    providers,
    localEventIds: [eventId],
    contracts: governanceContracts,
    providerOperatorPolicy,
  });
  assert.equal(reconciled.eligible, true);
  const anchors = exposureChainAnchorsForEvent(reconciled.events[0]);
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor(), {
    chainAnchor: anchors[0],
  });
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0, chainAnchor: anchors[1] },
  );
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATION_OPEN, {
    chainAnchor: anchors[2],
  });
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATOR_AUTHORIZED, {
    chainAnchor: anchors[3],
  });
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
    {
      descendantFinalized: true,
      terminalOutcome: "SETTLED",
      chainAnchor: anchors[4],
    },
  );
  const zero = hash("0");
  const unsignedCheckpoint = createCheckpoint({
    previousCheckpointHash: zero,
    finalizedBlockNumber: 100,
    finalizedBlockHash: hash("a"),
    exposureLedgerRoot: sha256Json(ledger),
    admissionBundleRoot: sha256Json([admission.bundleHash]),
    settlementBundleRoot: sha256Json([settlement.bundleHash]),
    contaminationLatch: false,
    incidentRoot: sha256Json([]),
    generatedCodeCommit: hash("f"),
    governanceExposureRoot: reconciled.exposureStateRoot,
    rawGovernanceEvidenceRoot: reconciled.rawEvidenceRoot,
  });
  const checkpoint = observerKeys.reduce(
    (value, keys, index) =>
      signCheckpoint(value, {
        ...keys,
        controllerDomain: `controller-${index}`,
      }),
    unsignedCheckpoint,
  );
  const result = validateAutonomyEvidence(
    {
      schema: "agentpool.v44.autonomy-evidence/v1",
      evaluationTimeMs: 2_500,
      exposureLedger: ledger,
      admissionBundles: [admission],
      settlementBundles: [settlement],
      controlDomainRegistry: signedControlRegistry(),
      governanceEventIds: [eventId],
      governanceEventProviders: providers,
      incidents: [],
      checkpoints: [checkpoint],
    },
    {
      controlDomainPolicy: controlPolicy,
      governanceEventPolicy: {
        fromBlock: 1,
        contracts: governanceContracts,
      },
      exposurePolicy: {
        preMatureMaximumSuccessfulSystemSettlements: 49,
      },
      providerOperatorPolicy,
      checkpointPolicy: {
        authorizedPublicKeys: observerKeys.map(
          (keys) => keys.publicKeyPem,
        ),
        signerBindings: controlPolicy.signerBindings,
        threshold: 2,
      },
      generatedCodeCommit: hash("f"),
      evaluationTimeMs: 2_500,
    },
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, "VERIFIED");
});

test("generated campaign fixtures cannot claim reliability or Work Power", () => {
  const setup = fs.readFileSync(
    new URL("../scripts/setup-v44-testnet-campaign.mjs", import.meta.url),
    "utf8",
  );
  assert.match(setup, /mechanicsOnly:\s*true/u);
  assert.match(setup, /eligibleForReliability:\s*false/u);
  assert.match(setup, /eligibleForWorkPower:\s*false/u);
});
