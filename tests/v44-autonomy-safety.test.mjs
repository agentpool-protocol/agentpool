import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SLOT_STATES,
  createCheckpoint,
  deterministicValidatorScore,
  exposureSlotId,
  exposureSummary,
  gradeControlDomains,
  newExposureLedger,
  reconcileFinalizedProviders,
  reduceGovernanceContamination,
  reserveExposureSlot,
  sha256Json,
  shadowBundleHash,
  transitionExposureSlot,
  validateCheckpointChain,
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
  const reports = [
    {
      reportHash: hash("5"),
      scoreBps: 7_000,
      evidenceHash: hash("6"),
      controlDomain: "domain-a",
    },
  ];
  const bundle = {
    schema: "agentpool.v44.shadow-admission/v1",
    issueHash: hash("1"),
    sourceCommit: hash("2"),
    specificationHash: hash("3"),
    testCommitment: hash("4"),
    revealHash: hash("7"),
    reports,
    reportRoot: sha256Json(reports),
  };
  bundle.bundleHash = shadowBundleHash(bundle);
  assert.equal(validateShadowBundle(bundle, { kind: "ADMISSION" }), bundle);
  bundle.reports[0].scoreBps = 9_999;
  assert.throws(
    () => validateShadowBundle(bundle, { kind: "ADMISSION" }),
    /REPORT_ROOT_INVALID/u,
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
  assert.equal(deterministicValidatorScore(reports), 8_000);
  assert.equal(gradeControlDomains(reports).grade, "OBSERVED_NOT_INDEPENDENT");
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
  const second = createCheckpoint({
    previousCheckpointHash: first.checkpointHash,
    finalizedBlockNumber: 101,
    finalizedBlockHash: hash("1"),
    exposureLedgerRoot: hash("2"),
    admissionBundleRoot: hash("3"),
    settlementBundleRoot: hash("4"),
    contaminationLatch: false,
    incidentRoot: hash("5"),
    generatedCodeCommit: hash("6"),
  });
  assert.equal(validateCheckpointChain([first, second]).valid, true);
  assert.throws(
    () => validateCheckpointChain([second]),
    /V44_CHECKPOINT_CHAIN_BROKEN/u,
  );
  const changed = structuredClone(second);
  changed.finalizedBlockHash = hash("7");
  assert.throws(
    () => validateCheckpointChain([first, changed]),
    /V44_CHECKPOINT_HASH_INVALID/u,
  );
});

test("exposure slot identity includes candidate and objective boundaries", () => {
  assert.notEqual(
    exposureSlotId(descriptor(0)),
    exposureSlotId(descriptor(1)),
  );
});

test("autonomy evidence validates exposure, bundles, checkpoint, and contamination together", () => {
  const evidence = {
    schema: "agentpool.v44.autonomy-evidence/v1",
    exposureLedger: newExposureLedger(),
    admissionBundles: [],
    settlementBundles: [],
    governanceEvents: [],
    checkpoints: [],
  };
  const result = validateAutonomyEvidence(evidence);
  assert.equal(result.valid, true);
  assert.equal(result.contamination.governanceContaminated, false);
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
