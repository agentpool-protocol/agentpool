import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  SLOT_STATES,
  collectGovernanceEventSnapshot,
  createControlDomainRegistry,
  createCheckpoint,
  deriveSystemSettlementEvidence,
  deterministicValidatorScore,
  encodeV44SystemSettledRawLog,
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
  signObserverReport,
  shadowBundleHash,
  transitionExposureSlot,
  validateCheckpointChain,
  validateControlDomainRegistry,
  validateAutonomyEvidence,
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
        scoreBps: 7_000,
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

test("unique exposure slots reserve worst-case SYSTEM settlements", () => {
  const ledger = newExposureLedger({
    maximumSuccessfulSystemSettlements: 2,
  });
  const first = reserveExposureSlot(ledger, descriptor(0));
  const second = reserveExposureSlot(ledger, descriptor(1));
  assert.throws(
    () => reserveExposureSlot(ledger, descriptor(2)),
    /V44_EXPOSURE_WORST_CASE_LIMIT/u,
  );
  assert.notEqual(first, second);
  assert.equal(exposureSummary(ledger).worstCaseSuccessfulSettlements, 2);
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
    authorizedPublicKeys: observerKeys.map((keys) => keys.publicKeyPem),
    threshold: 2,
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
});

test("provider event sets must agree with the complete local ledger", () => {
  const emitter = `0x${"11".repeat(20)}`;
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const rawEvent = encodeV44SystemSettledRawLog({
    transactionHash: hash("6"),
    blockHash: hash("a"),
    blockNumber: 10,
    logIndex: 0,
    address: emitter,
    issueHash: admission.issueHash,
    jobId: admission.jobId,
    milestone: admission.milestone,
    roundId: admission.roundId,
    artifactDigest: admission.artifactDigest,
    sourceSnapshotDigest: admission.sourceSnapshotDigest,
    specificationHash: admission.specificationHash,
    admissionBundleHash: admission.bundleHash,
    settlementBundleHash: settlement.bundleHash,
    exposureSlotId: admission.exposureSlotId,
    outcomeEventId: hash("e"),
  });
  const eventId = `${hash("6")}:0`;
  const providers = [
    {
      identity: "rpc-a",
      origin: "https://a.example",
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      rawEvents: [rawEvent],
    },
    {
      identity: "rpc-b",
      origin: "https://b.example",
      finalizedBlockNumber: 10,
      finalizedBlockHash: hash("a"),
      rawEvents: [rawEvent],
    },
  ];
  assert.equal(
    reconcileGovernanceEventSets({
      providers,
      localEventIds: [eventId],
      allowedEmitters: [emitter],
    }).eligible,
    true,
  );
  assert.equal(
    reconcileGovernanceEventSets({
      providers,
      localEventIds: [],
      allowedEmitters: [emitter],
    }).reason,
    "LOCAL_EVENT_SET_INCOMPLETE",
  );
});

test("governance snapshots are collected from raw finalized RPC evidence", async () => {
  const emitter = `0x${"11".repeat(20)}`;
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const encoded = encodeV44SystemSettledRawLog({
    transactionHash: hash("6"),
    blockHash: hash("a"),
    blockNumber: 100,
    logIndex: 0,
    address: emitter,
    transactionInput: "0x1234",
    issueHash: admission.issueHash,
    jobId: admission.jobId,
    milestone: admission.milestone,
    roundId: admission.roundId,
    artifactDigest: admission.artifactDigest,
    sourceSnapshotDigest: admission.sourceSnapshotDigest,
    specificationHash: admission.specificationHash,
    admissionBundleHash: admission.bundleHash,
    settlementBundleHash: settlement.bundleHash,
    exposureSlotId: admission.exposureSlotId,
    outcomeEventId: hash("e"),
  });
  const replies = {
    eth_chainId: "0x14a34",
    eth_getBlockByNumber: { number: "0x64", hash: hash("a") },
    eth_getLogs: [
      {
        ...encoded,
        blockNumber: "0x64",
        logIndex: "0x0",
      },
    ],
    eth_getTransactionReceipt: { status: "0x1" },
    eth_getTransactionByHash: { input: "0x1234" },
  };
  const snapshot = await collectGovernanceEventSnapshot({
    rpcUrl: "https://rpc-a.example/v1/key",
    fromBlock: 1,
    allowedEmitters: [emitter],
    fetcher: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: replies[request.method],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(snapshot.origin, "https://rpc-a.example");
  assert.equal(snapshot.finalizedBlockNumber, 100);
  assert.equal(snapshot.rawEvents.length, 1);
  assert.equal(snapshot.rawEvents[0].transactionInput, "0x1234");
});

test("complete independently signed evidence can reach VERIFIED", () => {
  const ledger = newExposureLedger();
  const slotId = reserveExposureSlot(ledger, descriptor());
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.BOUND_TO_JOB_MILESTONE,
    { jobId, milestone: 0 },
  );
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATION_OPEN);
  transitionExposureSlot(ledger, slotId, SLOT_STATES.VALIDATOR_AUTHORIZED);
  transitionExposureSlot(
    ledger,
    slotId,
    SLOT_STATES.SUCCESSFULLY_CONSUMED,
    { descendantFinalized: true, terminalOutcome: "SETTLED" },
  );
  const admission = shadowBundle("ADMISSION");
  const settlement = shadowBundle("SETTLEMENT");
  const emitter = `0x${"11".repeat(20)}`;
  const transactionHash = hash("6");
  const rawEvent = encodeV44SystemSettledRawLog({
    transactionHash,
    blockHash: hash("a"),
    blockNumber: 100,
    logIndex: 0,
    address: emitter,
    issueHash: admission.issueHash,
    jobId: admission.jobId,
    milestone: admission.milestone,
    roundId: admission.roundId,
    artifactDigest: admission.artifactDigest,
    sourceSnapshotDigest: admission.sourceSnapshotDigest,
    specificationHash: admission.specificationHash,
    admissionBundleHash: admission.bundleHash,
    settlementBundleHash: settlement.bundleHash,
    exposureSlotId: admission.exposureSlotId,
    outcomeEventId: hash("e"),
  });
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
  });
  const checkpoint = observerKeys.reduce(
    (value, keys, index) =>
      signCheckpoint(value, {
        ...keys,
        controllerDomain: `controller-${index}`,
      }),
    unsignedCheckpoint,
  );
  const eventId = `${transactionHash}:0`;
  const result = validateAutonomyEvidence(
    {
      schema: "agentpool.v44.autonomy-evidence/v1",
      evaluationTimeMs: 2_500,
      exposureLedger: ledger,
      admissionBundles: [admission],
      settlementBundles: [settlement],
      controlDomainRegistry: signedControlRegistry(),
      governanceEventIds: [eventId],
      governanceEventProviders: [
        {
          identity: "rpc-a",
          origin: "https://a.example",
          finalizedBlockNumber: 100,
          finalizedBlockHash: hash("a"),
          rawEvents: [rawEvent],
        },
        {
          identity: "rpc-b",
          origin: "https://b.example",
          finalizedBlockNumber: 100,
          finalizedBlockHash: hash("a"),
          rawEvents: [rawEvent],
        },
      ],
      incidents: [],
      checkpoints: [checkpoint],
    },
    {
      controlDomainPolicy: controlPolicy,
      governanceEventPolicy: {
        fromBlock: 1,
        allowedEmitters: [emitter],
      },
      checkpointPolicy: {
        authorizedPublicKeys: observerKeys.map(
          (keys) => keys.publicKeyPem,
        ),
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
