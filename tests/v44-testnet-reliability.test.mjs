import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertClosedJobSemantic,
  assertCanonicalCreationInput,
  autonomyPolicyIdentity,
  autonomyPolicyConfigurationHash,
  autonomySignerSetHash,
  activationBindingsRoot,
  activationSignerSetHash,
  blockedReliabilityReport,
  collectMaturityProviderSnapshot,
  collectMaturityAuthorizationPublicationSnapshot,
  collectMaturityReadinessEvidence,
  collectGovernanceDryRunChecks,
  collectPolicyActivationPublicationSnapshot,
  createPolicyActivationAnchor,
  DEPLOYMENT_SCHEMA,
  evaluateReliability,
  loadReliabilityPolicy,
  observationAttestationMessage,
  reconcileRpcEvidenceSnapshots,
  reconcileMaturityReadinessEvidence,
  reconcileMaturityAuthorizationPublicationSnapshots,
  reconcilePolicyActivationPublicationSnapshots,
  signPolicyActivationAnchor,
  validateAutonomyPolicy,
  validateObservations,
  validateTestnetDeployment,
  verifyHistoricalContractSourceEvidenceFile,
  verifyObservationAttestations,
  verifyObservationSemantic,
  verifyMatureApprovalPopulation,
  verifyPublicTestnetReliabilityGate,
} from "../scripts/lib/v44-testnet-reliability.mjs";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeDeployData,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  merkleCatalog,
  artifact,
  assertReleaseDependenciesTracked,
  loadAndValidateConfig,
  sha256Json,
} from "../scripts/lib/v44-mainnet.mjs";

const ROOT = process.cwd();
const source = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const SOURCE_COMMIT = "a".repeat(40);
const EVIDENCE_PIPELINE_COMMIT = "d".repeat(40);
const POLICY_HASH = "e".repeat(64);
const ACTIVATION_AUTHORITY = "0xf000000000000000000000000000000000000001";
const ACTIVATION_AUTHORITY_RUNTIME = artifact(
  "AgentPoolV44ThresholdAuthority",
).deployedBytecode;
const ACTIVATION_OWNERS = [
  "0xf000000000000000000000000000000000000011",
  "0xf000000000000000000000000000000000000012",
  "0xf000000000000000000000000000000000000013",
];
function activateAutonomyPolicy(policy) {
  policy.autonomyV2.policyActivation = {
    configurationStatus: "ACTIVE",
    contractKey: "policyAnchor",
    thresholdAuthority: {
      address: ACTIVATION_AUTHORITY,
      runtimeCodeHash: keccak256(ACTIVATION_AUTHORITY_RUNTIME),
      owners: ACTIVATION_OWNERS,
      threshold: 2,
      ownerBindings: ACTIVATION_OWNERS.map((owner, index) => ({
      owner,
      controllerDomainId: `activation-controller-${index}`,
      custodyDomainId: `activation-custody-${index}`,
      corroborationEvidenceHash: `0x${(index + 1)
        .toString(16)
        .padStart(64, "0")}`,
      })),
    },
    anchorHistory: [],
    restartObservationWindowOnChange: true,
    rotationPolicy: "NEW_CONTRACT_AND_WINDOW",
  };
  const anchor = createPolicyActivationAnchor({
    policyAnchorAddress: deployment().contracts.policyAnchor,
    activationAuthority: ACTIVATION_AUTHORITY,
    policyConfigurationHash: autonomyPolicyConfigurationHash(
      policy.autonomyV2,
    ),
    signerSetHash: autonomySignerSetHash(policy.autonomyV2),
    activationSignerSetHash: activationSignerSetHash(
      policy.autonomyV2.policyActivation,
    ),
    activationThreshold:
      policy.autonomyV2.policyActivation.thresholdAuthority.threshold,
    activationBindingsRoot: activationBindingsRoot(
      policy.autonomyV2.policyActivation,
    ),
    evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
    activationSequence: 1,
    previousAnchorHash: `0x${"00".repeat(32)}`,
    transparencyLogRoot: `0x${"cd".repeat(32)}`,
  });
  anchor.publication = {
    transactionHash: `0x${"98".repeat(32)}`,
    logIndex: 0,
  };
  policy.autonomyV2.policyActivation.anchorHistory = [anchor];
  return policy;
}

function activateObserverIndependencePolicy(policy) {
  policy.autonomyV2.observerIndependencePolicy = {
    configurationStatus: "ACTIVE",
    bindings: OBSERVER_ACCOUNTS.map((account, index) => ({
      observer: account.address,
      operatorGroup: OBSERVER_GROUPS[index],
      controllerDomainId: `observer-controller-${index}`,
      custodyDomainId: `observer-custody-${index}`,
      corroborationEvidenceHash: `0x${(index + 20)
        .toString(16)
        .padStart(64, "0")}`,
    })),
  };
  return policy;
}

function trustedActivationPublications(policy) {
  return policy.autonomyV2.policyActivation.anchorHistory.map((anchor) => ({
    anchorHash: anchor.anchorHash,
    activationSequence: anchor.activationSequence,
    policyConfigurationHash: `0x${anchor.policyConfigurationHash}`,
    activationAuthority: anchor.activationAuthority,
    signerSetHash: `0x${anchor.signerSetHash}`,
    activationSignerSetHash: `0x${anchor.activationSignerSetHash}`,
    activationThreshold: anchor.activationThreshold,
    activationBindingsRoot: `0x${anchor.activationBindingsRoot}`,
    evidencePipelineCommit: `0x${anchor.evidencePipelineCommit}`,
    previousAnchorHash: anchor.previousAnchorHash,
    transparencyLogRoot: anchor.transparencyLogRoot,
    transactionHash: anchor.publication.transactionHash,
    logIndex: anchor.publication.logIndex,
    blockNumber: 1,
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
    authorityRuntimeCodeHash:
      policy.autonomyV2.policyActivation.thresholdAuthority.runtimeCodeHash,
    authorityOwners:
      policy.autonomyV2.policyActivation.thresholdAuthority.owners
        .map((owner) => owner.toLowerCase())
        .sort(),
    authorityThreshold:
      policy.autonomyV2.policyActivation.thresholdAuthority.threshold,
  }));
}

function policyIdentityOptions(policy, manifest = deployment()) {
  return {
    policyAnchorAddress: manifest.contracts.policyAnchor,
    trustedPublications: trustedActivationPublications(policy),
  };
}
const CONTRACT_TYPES = {
  token: "AgentPoolV44Token",
  thresholdAuthority: "AgentPoolV44ThresholdAuthority",
  policyAnchor: "AgentPoolV44PolicyAnchor",
  maturityAnchor: "AgentPoolV44MaturityAnchor",
  settlementRouter: "AgentPoolV43SettlementRouter",
  releaseRegistry: "AgentPoolV43ReleaseRegistry",
  capacityRegistry: "AgentPoolV43CapacityRegistry",
  userEscrow: "AgentPoolV43UserEscrowKernel",
  coreEpochVault: "AgentPoolV43EpochVault",
  evolutionEpochVault: "AgentPoolV43EpochVault",
  contributionLedger: "AgentPoolV43ContributionLedger",
  proofRegistry: "AgentPoolV432ProofRegistry",
  evolutionConsensus: "AgentPoolV43EvolutionConsensus",
  objectiveVerifier: "AgentPoolV43HashObjectiveVerifier",
  systemIssueGate: "AgentPoolV435SystemIssueGate",
  transitionIssueConsensus: "AgentPoolV435TransitionIssueConsensus",
  issueConsensus: "AgentPoolV432IssueConsensus",
  taskMarket: "AgentPoolV432TaskMarket",
};
const SOURCE_EVIDENCE = {
  schema: "agentpool.mainnet.v44.source-reproducibility/v1",
  release: "4.4.0-ownerless-mainnet-candidate",
  sourceCommit: SOURCE_COMMIT,
  evidenceSha256: "b".repeat(64),
  financeInvariantHash: `0x${"c".repeat(64)}`,
  configSha256: "f".repeat(64),
  artifacts: Object.fromEntries(
    [...new Set(Object.values(CONTRACT_TYPES))].map((type, index) => [
      type,
      {
        creationBytecodeHash: `0x${(index + 100)
          .toString(16)
          .padStart(64, "0")}`,
      },
    ]),
  ),
};

function systemJobInput({
  budget = 10n,
  allocation = 10n,
  keeperFee = 0n,
  candidateBudgetCap = 100n,
  totalBudgetCap = 1_000n,
  issueId = `0x${"61".repeat(32)}`,
} = {}) {
  const abi = artifact("AgentPoolV432TaskMarket").abi;
  const verifier = "0x2000000000000000000000000000000000000000";
  const worker = "0x3000000000000000000000000000000000000000";
  const validatorRoot = `0x${"62".repeat(32)}`;
  const issue = [
    issueId,
    "0x0000000000000000000000000000000000000000",
    `0x${"63".repeat(32)}`,
    verifier,
    `0x${"64".repeat(32)}`,
    `0x${"65".repeat(32)}`,
    validatorRoot,
    candidateBudgetCap,
    totalBudgetCap,
    5,
    3,
    8_000,
    2,
    3,
    9_999_999_999n,
  ];
  const terms = [[
    worker,
    verifier,
    `0x${"66".repeat(32)}`,
    `0x${"67".repeat(32)}`,
    `0x${"68".repeat(32)}`,
    `0x${"69".repeat(32)}`,
    allocation,
    1n,
    keeperFee,
    9_999_999_999n,
    1,
    3,
    8_000,
    60,
    60,
  ]];
  return {
    issue,
    input: encodeFunctionData({
      abi,
      functionName: "createSystemJobV2",
      args: [
        3,
        budget,
        `0x${"6a".repeat(32)}`,
        `0x${"6b".repeat(32)}`,
        issue,
        [],
        terms,
        [[validatorRoot, 2]],
        [0],
        [[]],
      ],
    }),
  };
}

function revertedClient(errorName, observedBlocks = []) {
  return {
    call: async ({ blockNumber }) => {
      observedBlocks.push(blockNumber);
      throw {
        data: keccak256(toBytes(`${errorName}()`)).slice(0, 10),
      };
    },
  };
}

const OBSERVER_ACCOUNTS = [
  privateKeyToAccount(`0x${"11".repeat(32)}`),
  privateKeyToAccount(`0x${"22".repeat(32)}`),
  privateKeyToAccount(`0x${"33".repeat(32)}`),
];
const OBSERVER_GROUPS = [
  `0x${"a1".repeat(32)}`,
  `0x${"b2".repeat(32)}`,
  `0x${"c3".repeat(32)}`,
];

function observerLeaf(address, group) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [address, group],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [inner]),
  );
}

function deployment() {
  const contractKeys = Object.keys(CONTRACT_TYPES);
  const value = {
    schema: DEPLOYMENT_SCHEMA,
    chainId: 84532,
    network: "Base Sepolia",
    release: "4.4.0-ownerless-mainnet-candidate",
    sourceCommit: SOURCE_COMMIT,
    sourceEvidenceSha256: SOURCE_EVIDENCE.evidenceSha256,
    financeInvariantHash: SOURCE_EVIDENCE.financeInvariantHash,
    configSha256: SOURCE_EVIDENCE.configSha256,
    deployer: "0x1000000000000000000000000000000000000000",
    policyActivationAuthority: ACTIVATION_AUTHORITY,
    thresholdAuthorityOwners: [...ACTIVATION_OWNERS].sort(),
    thresholdAuthorityThreshold: 2,
    deploymentBlock: 1,
    genesisStart: 1,
    genesisRelease: `0x${"11".repeat(32)}`,
    genesisModuleHash: `0x${"15".repeat(32)}`,
    genesisManifestHash: `0x${"16".repeat(32)}`,
    bootstrapRoot: `0x${"12".repeat(32)}`,
    dynamicValidatorRoot: merkleCatalog(
      OBSERVER_ACCOUNTS.map((account, index) =>
        observerLeaf(account.address, OBSERVER_GROUPS[index]),
      ),
    ).root,
    bootstrapVerifierCodehash: `0x${"14".repeat(32)}`,
    bootstrap: {
      validators: OBSERVER_ACCOUNTS.map((account, index) => ({
        address: account.address,
        group: OBSERVER_GROUPS[index],
      })),
    },
    contracts: Object.fromEntries(
      contractKeys.map((key, index) => [
        key,
        `0x${(index + 1).toString(16).padStart(40, "0")}`,
      ]),
    ),
    deployedCodeHashes: Object.fromEntries(
      contractKeys.map((key, index) => [
        key,
        `0x${(index + 1).toString(16).padStart(64, "0")}`,
      ]),
    ),
    deploymentTransactions: Object.fromEntries(
      contractKeys.map((key, index) => [
        key,
        `0x${(index + 50).toString(16).padStart(64, "0")}`,
      ]),
    ),
    creationInputHashes: Object.fromEntries(
      contractKeys.map((key, index) => [
        key,
        `0x${(index + 75).toString(16).padStart(64, "0")}`,
      ]),
    ),
    artifactTypes: { ...CONTRACT_TYPES },
    artifactCreationBytecodeHashes: Object.fromEntries(
      Object.entries(SOURCE_EVIDENCE.artifacts).map(([type, artifact]) => [
        type,
        artifact.creationBytecodeHash,
      ]),
    ),
  };
  value.contracts.thresholdAuthority = ACTIVATION_AUTHORITY;
  value.deployedCodeHashes.thresholdAuthority = keccak256(
    ACTIVATION_AUTHORITY_RUNTIME,
  );
  value.manifestSha256 = sha256Json(value);
  return value;
}

function observationEntries(policy) {
  const entries = [];
  let nonce = 1;
  for (const [category, rule] of Object.entries(policy.categories)) {
    for (let index = 0; index < rule.minimum; index += 1) {
      entries.push({
        category,
        txHash: `0x${nonce.toString(16).padStart(64, "0")}`,
        contractKey: rule.contractKey,
        expectedStatus: rule.transactionStatus,
        blockNumber: nonce,
      });
      nonce += 1;
    }
  }
  while (entries.length < policy.minimumVerifiedTransactions) {
    const rule = policy.categories.SYSTEM_SETTLED;
    entries.push({
      category: "SYSTEM_SETTLED",
      txHash: `0x${nonce.toString(16).padStart(64, "0")}`,
      contractKey: rule.contractKey,
      expectedStatus: rule.transactionStatus,
      blockNumber: nonce,
    });
    nonce += 1;
  }
  return entries;
}

function observations(
  policy,
  manifest,
  {
    policySha256 = POLICY_HASH,
    evidencePipelineCommit = EVIDENCE_PIPELINE_COMMIT,
  } = {},
) {
  const policyIdentity = autonomyPolicyIdentity(
    policy.autonomyV2,
    evidencePipelineCommit,
    policyIdentityOptions(policy, manifest),
  );
  return {
    schema: "agentpool.testnet.v44.observations/v1",
    observedChainId: 84532,
    release: "4.4.0-ownerless-mainnet-candidate",
    contractSourceCommit: SOURCE_COMMIT,
    evidencePipelineCommit,
    deploymentManifestSha256: manifest.manifestSha256,
    policySha256,
    signerSetHash: policyIdentity.signerSetHash,
    policyActivatedAt: policyIdentity.activatedAt,
    policyActivatedBlock: policyIdentity.activatedBlock,
    policyActivationSequence: policyIdentity.activationSequence,
    policyActivationAnchorHash: policyIdentity.activationAnchorHash,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-04-01T00:00:00.000Z",
    observations: observationEntries(policy),
    incidents: [],
    attestations: [],
  };
}

function completeEvidence(policy, ledger) {
  return {
    autonomyV2: {
      valid: true,
      status: "VERIFIED",
    },
    attestationEvidence: {
      verified: true,
      meetsIndependence: true,
      observerCount: 2,
      observerGroupCount: 2,
    },
    rpcEvidence: {
      liveRpcVerified: true,
      providerCount: 2,
      verifiedTransactionCount: ledger.observations.length,
      contributingAgents: Array.from({ length: 5 }, (_, index) => `${index}`),
      contributingOperatorGroups: ["a", "b", "c"],
      latestObservedBlock: 100,
      earliestObservedBlock: 1,
      earliestObservedTimestamp: Date.parse(ledger.startedAt),
      latestObservedTimestamp: Date.parse(ledger.endedAt),
      latestBlock: 100,
      indexerLagBlocks: 0,
    },
    generatedAt: "2026-04-01T01:00:00.000Z",
    policySha256: policy.policySha256,
    evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
    deploymentFileSha256: "d".repeat(64),
    observationsFileSha256: "e".repeat(64),
    sourceEvidenceFileSha256: "f".repeat(64),
  };
}

test("v4.4 public-testnet policy requires a 90-day live campaign", () => {
  const { policy } = loadReliabilityPolicy();
  assert.equal(policy.minimumObservationDays, 90);
  assert.equal(policy.minimumContributingAgents, 5);
  assert.equal(policy.minimumContributingOperatorGroups, 3);
  assert.equal(policy.minimumIndependentObservers, 2);
  assert.equal(policy.maximumOpenCriticalIncidents, 0);
  assert.equal(policy.categories.SYSTEM_SETTLED.minimum, 50);
  assert.equal(policy.categories.EXTERNAL_SETTLED.minimum, 25);
  assert.equal(
    policy.autonomyV2.exposurePolicy
      .preMatureMaximumSuccessfulSystemSettlements,
    49,
  );
  assert.equal(
    policy.autonomyV2.exposurePolicy.maturityTransitionSettlement,
    50,
  );
  assert.equal(
    policy.autonomyV2.governanceEventPolicy.fromBlock,
    "deployment.deploymentBlock",
  );
  assert.deepEqual(
    policy.autonomyV2.governanceEventPolicy.contractKeys.sort(),
    [
      "contributionLedger",
      "issueConsensus",
      "proofRegistry",
      "systemIssueGate",
      "taskMarket",
      "transitionIssueConsensus",
    ],
  );
  assert.equal(
    policy.autonomyV2.maturityAuthorizationPolicy
      .maximumControlDomainShareBps,
    2_999,
  );
  assert.equal(
    policy.autonomyV2.controlDomainPolicy.configurationStatus,
    "PENDING_EXTERNAL_KEYS",
  );
  assert.equal(
    policy.autonomyV2.policyActivation.configurationStatus,
    "PENDING_EXTERNAL_ANCHOR",
  );
});

test("the externally supplied activation overlay is revalidated", () => {
  const active = loadReliabilityPolicy().policy;
  activateAutonomyPolicy(active);
  assert.doesNotThrow(() => validateAutonomyPolicy(active.autonomyV2));

  const missingBindings = structuredClone(active.autonomyV2);
  missingBindings.policyActivation.thresholdAuthority.ownerBindings = [];
  assert.throws(
    () => validateAutonomyPolicy(missingBindings),
    /V44_TESTNET_AUTONOMY_POLICY_INVALID/u,
  );

  const commonController = structuredClone(active.autonomyV2);
  for (const binding of commonController.policyActivation.thresholdAuthority
    .ownerBindings) {
    binding.controllerDomainId = "one-controller";
  }
  assert.throws(
    () => validateAutonomyPolicy(commonController),
    /V44_TESTNET_AUTONOMY_POLICY_INVALID/u,
  );
});

test("a maturity dry-run locator belongs to the signed observations, not the activation policy", () => {
  const policyEvidence = loadReliabilityPolicy();
  activateAutonomyPolicy(policyEvidence.policy);
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  ledger.autonomyEvidence = { maturityAuthorization: {} };
  assert.throws(
    () =>
      validateObservations(ledger, {
        policy: policyEvidence.policy,
        policySha256: POLICY_HASH,
        deployment: manifest,
        evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
        trustedActivationPublications: trustedActivationPublications(
          policyEvidence.policy,
        ),
      }),
    /V44_TESTNET_MATURITY_DRY_RUN_OBSERVATION_REQUIRED/u,
  );
  ledger.maturityReadinessEvidence = {
    governanceDryRun: {
      transcriptPath: "outputs/governance-dry-run.json",
      transcriptSha256: "a".repeat(64),
    },
  };
  assert.doesNotThrow(() =>
    validateObservations(ledger, {
      policy: policyEvidence.policy,
      policySha256: POLICY_HASH,
      deployment: manifest,
      evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
      trustedActivationPublications: trustedActivationPublications(
        policyEvidence.policy,
      ),
    }),
  );
});

test("legacy v4.3 evidence cannot impersonate the v4.4 campaign", () => {
  const manifest = deployment();
  manifest.release = "4.3.5-staged-autonomy-alpha";
  const unsigned = structuredClone(manifest);
  delete unsigned.manifestSha256;
  manifest.manifestSha256 = sha256Json(unsigned);
  assert.throws(
    () => validateTestnetDeployment(manifest, SOURCE_EVIDENCE),
    /V44_TESTNET_DEPLOYMENT_IDENTITY_INVALID/u,
  );
});

test("historical contract provenance is verified separately from the evidence pipeline HEAD", () => {
  const manifest = JSON.parse(
    source("deployments/84532.v44.json"),
  );
  const verified = verifyHistoricalContractSourceEvidenceFile(
    path.join(ROOT, "deployments", "84532.v44.source-reproducibility.json"),
    manifest,
  );
  assert.equal(verified.evidence.sourceCommit, manifest.sourceCommit);
  assert.notEqual(
    verified.evidence.sourceCommit,
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
  );
  assert.equal(
    validateTestnetDeployment(manifest, verified.evidence).sourceCommit,
    manifest.sourceCommit,
  );
});

test("deployment provenance rejects altered ReleaseRegistry constructor inputs", () => {
  const manifest = deployment();
  const compiled = artifact("AgentPoolV43ReleaseRegistry");
  const wrongInput = encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: [
      manifest.genesisRelease,
      `0x${"99".repeat(32)}`,
      manifest.genesisManifestHash,
      manifest.deployer,
    ],
  });
  assert.throws(
    () =>
      assertCanonicalCreationInput({
        key: "releaseRegistry",
        deployment: manifest,
        config: loadAndValidateConfig().config,
        input: wrongInput,
      }),
    /V44_TESTNET_DEPLOYMENT_CONSTRUCTOR_INVALID:releaseRegistry/u,
  );
});

test("observation transaction hashes cannot be reused across claims", () => {
  const { policy } = loadReliabilityPolicy();
  const manifest = deployment();
  const ledger = observations(policy, manifest);
  ledger.observations[1].txHash = ledger.observations[0].txHash;
  assert.throws(
    () =>
      validateObservations(ledger, {
        policy,
        policySha256: POLICY_HASH,
        deployment: manifest,
        evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
      }),
    /V44_TESTNET_OBSERVATION_TX_REUSED/u,
  );
});

test("changing the signer policy invalidates an existing observation window", () => {
  const { policy } = loadReliabilityPolicy();
  const manifest = deployment();
  const ledger = observations(policy, manifest);
  const changedPolicy = structuredClone(policy);
  changedPolicy.autonomyV2.controlDomainPolicy.threshold = 3;
  assert.throws(
    () =>
      validateObservations(ledger, {
        policy: changedPolicy,
        policySha256: POLICY_HASH,
        deployment: manifest,
        evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
      }),
    /V44_TESTNET_OBSERVATIONS_IDENTITY_INVALID/u,
  );
});

test("policy activation time cannot be backdated by editing tracked JSON", () => {
  const { policy } = loadReliabilityPolicy();
  const active = activateAutonomyPolicy(structuredClone(policy));
  const original = autonomyPolicyIdentity(
    active.autonomyV2,
    EVIDENCE_PIPELINE_COMMIT,
    policyIdentityOptions(active),
  );
  assert.equal(original.activationSequence, 1);
  active.autonomyV2.policyActivation.anchorHistory[0].transparencyLogRoot =
    `0x${"ef".repeat(32)}`;
  assert.throws(
    () =>
      autonomyPolicyIdentity(
        active.autonomyV2,
        EVIDENCE_PIPELINE_COMMIT,
        policyIdentityOptions(active),
      ),
    /V44_POLICY_ACTIVATION_ANCHOR_INVALID/u,
  );
});

test("trusted policy changes require a new activation sequence", () => {
  const { policy } = loadReliabilityPolicy();
  const active = activateAutonomyPolicy(structuredClone(policy));
  active.autonomyV2.exposurePolicy
    .preMatureMaximumSuccessfulSystemSettlements = 48;
  assert.throws(
    () =>
      autonomyPolicyIdentity(
        active.autonomyV2,
        EVIDENCE_PIPELINE_COMMIT,
        policyIdentityOptions(active),
      ),
    /V44_POLICY_ACTIVATION_ANCHOR_INVALID/u,
  );
});

test("observer control and custody bindings are fixed by policy activation", () => {
  const { policy } = loadReliabilityPolicy();
  const active = activateAutonomyPolicy(structuredClone(policy));
  activateObserverIndependencePolicy(active);
  assert.throws(
    () =>
      autonomyPolicyIdentity(
        active.autonomyV2,
        EVIDENCE_PIPELINE_COMMIT,
        policyIdentityOptions(active),
      ),
    /V44_POLICY_ACTIVATION_ANCHOR_INVALID/u,
  );
});

test("delayed offchain signatures and in-place authority rotation cannot activate policy", () => {
  const { policy } = loadReliabilityPolicy();
  const active = activateAutonomyPolicy(structuredClone(policy));
  const anchor = active.autonomyV2.policyActivation.anchorHistory[0];
  assert.throws(
    () => signPolicyActivationAnchor(anchor, {}),
    /V44_POLICY_ACTIVATION_OFFCHAIN_SIGNATURES_UNSUPPORTED/u,
  );
  active.autonomyV2.policyActivation.anchorHistory.push({ ...anchor });
  assert.throws(
    () =>
      autonomyPolicyIdentity(
        active.autonomyV2,
        EVIDENCE_PIPELINE_COMMIT,
        policyIdentityOptions(active),
      ),
    /V44_POLICY_ACTIVATION_ROTATION_REQUIRES_NEW_CONTRACT/u,
  );
});

test("policy activation time comes from the finalized threshold-authorized anchor event", async () => {
  const { policy } = loadReliabilityPolicy();
  const active = activateAutonomyPolicy(structuredClone(policy));
  const manifest = deployment();
  const anchor = active.autonomyV2.policyActivation.anchorHistory[0];
  const eventAbi = [
    { name: "anchorHash", type: "bytes32", indexed: true },
    { name: "activationSequence", type: "uint64", indexed: true },
    { name: "policyConfigurationHash", type: "bytes32", indexed: true },
    { name: "activationAuthority", type: "address", indexed: false },
    { name: "signerSetHash", type: "bytes32", indexed: false },
    { name: "activationSignerSetHash", type: "bytes32", indexed: false },
    { name: "activationThreshold", type: "uint16", indexed: false },
    { name: "activationBindingsRoot", type: "bytes32", indexed: false },
    { name: "evidencePipelineCommit", type: "bytes20", indexed: false },
    { name: "previousAnchorHash", type: "bytes32", indexed: false },
    { name: "transparencyLogRoot", type: "bytes32", indexed: false },
  ];
  const fullAbi = {
    type: "event",
    name: "PolicyActivationAnchored",
    inputs: eventAbi,
  };
  const indexedArgs = {
    anchorHash: anchor.anchorHash,
    activationSequence: BigInt(anchor.activationSequence),
    policyConfigurationHash: `0x${anchor.policyConfigurationHash}`,
  };
  const log = {
    address: manifest.contracts.policyAnchor,
    logIndex: 0,
    topics: encodeEventTopics({
      abi: [fullAbi],
      eventName: fullAbi.name,
      args: indexedArgs,
    }),
    data: encodeAbiParameters(
      eventAbi.filter((input) => !input.indexed),
      [
        anchor.activationAuthority,
        `0x${anchor.signerSetHash}`,
        `0x${anchor.activationSignerSetHash}`,
        anchor.activationThreshold,
        `0x${anchor.activationBindingsRoot}`,
        `0x${anchor.evidencePipelineCommit}`,
        anchor.previousAnchorHash,
        anchor.transparencyLogRoot,
      ],
    ),
  };
  const blockHash = `0x${"ab".repeat(32)}`;
  const authorityInput = encodeFunctionData({
    abi: artifact("AgentPoolV44ThresholdAuthority").abi,
    functionName: "executePolicyActivation",
    args: [
      manifest.contracts.policyAnchor,
      BigInt(anchor.activationSequence),
      `0x${anchor.policyConfigurationHash}`,
      `0x${anchor.signerSetHash}`,
      `0x${anchor.activationSignerSetHash}`,
      anchor.activationThreshold,
      `0x${anchor.activationBindingsRoot}`,
      `0x${anchor.evidencePipelineCommit}`,
      anchor.previousAnchorHash,
      anchor.transparencyLogRoot,
      0n,
      9_999_999_999n,
      ["0x01", "0x02"],
    ],
  });
  const client = {
    getBlock: async ({ blockTag }) =>
      blockTag === "finalized"
        ? { number: 100n, hash: `0x${"fe".repeat(32)}` }
        : {
            number: 1n,
            hash: blockHash,
            timestamp: BigInt(Date.parse("2026-01-01T00:00:00.000Z") / 1_000),
          },
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 1n,
      blockHash,
      logs: [log],
    }),
    getTransaction: async () => ({
      to: ACTIVATION_AUTHORITY,
      input: authorityInput,
    }),
    getCode: async ({ address }) =>
      address.toLowerCase() === ACTIVATION_AUTHORITY.toLowerCase()
        ? ACTIVATION_AUTHORITY_RUNTIME
        : artifact("AgentPoolV44PolicyAnchor").deployedBytecode,
    readContract: async ({ functionName }) => {
      if (functionName === "ACTIVATION_AUTHORITY") return ACTIVATION_AUTHORITY;
      if (functionName === "getOwners") return ACTIVATION_OWNERS;
      if (functionName === "getThreshold") return 2n;
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  };
  manifest.deployedCodeHashes.policyAnchor = keccak256(
    artifact("AgentPoolV44PolicyAnchor").deployedBytecode,
  );
  const snapshots = await Promise.all(
    ["a", "b"].map((name) =>
      collectPolicyActivationPublicationSnapshot({
        rpcUrl: `https://${name}.example`,
        deployment: manifest,
        activation: active.autonomyV2.policyActivation,
        providerOperatorId: `rpc-${name}`,
        client,
      }),
    ),
  );
  const reconciled = reconcilePolicyActivationPublicationSnapshots({
    providers: snapshots,
    providerOperatorPolicy: {
      configurationStatus: "ACTIVE",
      providers: ["a", "b"].map((name) => ({
        operatorId: `rpc-${name}`,
        allowedOrigins: [`https://${name}.example`],
        custodyDomainId: `custody-${name}`,
      })),
    },
  });
  await assert.rejects(
    collectPolicyActivationPublicationSnapshot({
      rpcUrl: "https://a.example",
      deployment: manifest,
      activation: active.autonomyV2.policyActivation,
      providerOperatorId: "rpc-a",
      client: {
        ...client,
        getTransaction: async () => ({
          to: manifest.contracts.policyAnchor,
          input: authorityInput,
        }),
      },
    }),
    /V44_POLICY_ACTIVATION_PUBLICATION_INVALID/u,
  );
  assert.equal(reconciled.publications[0].blockNumber, 1);
  assert.equal(
    autonomyPolicyIdentity(active.autonomyV2, EVIDENCE_PIPELINE_COMMIT, {
      policyAnchorAddress: manifest.contracts.policyAnchor,
      trustedPublications: reconciled.publications,
    }).activatedAt,
    "2026-01-01T00:00:00.000Z",
  );
});

test("maturity authorization must be published by the exact threshold authority", async () => {
  const manifest = deployment();
  manifest.deployedCodeHashes.maturityAnchor = keccak256(
    artifact("AgentPoolV44MaturityAnchor").deployedBytecode,
  );
  const authorization = {
    authorizationId: "51".repeat(32),
    precommitCheckpointHash: `0x${"52".repeat(32)}`,
    authorizedExposureSlotId: `0x${"53".repeat(32)}`,
    admissionBundleHash: `0x${"54".repeat(32)}`,
    sourceCommit: "55".repeat(20),
    deploymentManifestSha256: "56".repeat(32),
    publication: {
      transactionHash: `0x${"57".repeat(32)}`,
      logIndex: 0,
    },
  };
  const maturityEvent = artifact("AgentPoolV44MaturityAnchor").abi.find(
    (entry) =>
      entry.type === "event" &&
      entry.name === "MaturityAuthorizationPublished",
  );
  const publicationHash = `0x${"58".repeat(32)}`;
  const eventArgs = {
    publicationHash,
    authorizationId: `0x${authorization.authorizationId}`,
    exposureSlotId: authorization.authorizedExposureSlotId,
    precommitCheckpointHash: authorization.precommitCheckpointHash,
    admissionBundleHash: authorization.admissionBundleHash,
    evidencePipelineCommit: `0x${authorization.sourceCommit}`,
    deploymentManifestHash: `0x${authorization.deploymentManifestSha256}`,
  };
  const log = {
    address: manifest.contracts.maturityAnchor,
    topics: encodeEventTopics({
      abi: [maturityEvent],
      eventName: maturityEvent.name,
      args: eventArgs,
    }),
    data: encodeAbiParameters(
      maturityEvent.inputs.filter((input) => !input.indexed),
      maturityEvent.inputs
        .filter((input) => !input.indexed)
        .map((input) => eventArgs[input.name]),
    ),
    logIndex: 0,
  };
  const authorityInput = (signatures) =>
    encodeFunctionData({
      abi: artifact("AgentPoolV44ThresholdAuthority").abi,
      functionName: "executeMaturityPublication",
      args: [
        manifest.contracts.maturityAnchor,
        `0x${authorization.authorizationId}`,
        authorization.precommitCheckpointHash,
        authorization.authorizedExposureSlotId,
        authorization.admissionBundleHash,
        `0x${authorization.sourceCommit}`,
        `0x${authorization.deploymentManifestSha256}`,
        1n,
        9_999_999_999n,
        signatures,
      ],
    });
  const blockHash = `0x${"59".repeat(32)}`;
  const client = {
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 10n,
      blockHash,
      logs: [log],
    }),
    getTransaction: async () => ({
      to: manifest.contracts.thresholdAuthority,
      input: authorityInput(["0x01", "0x02"]),
    }),
    getBlock: async ({ blockTag }) =>
      blockTag === "finalized"
        ? { number: 100n, hash: `0x${"5a".repeat(32)}` }
        : { number: 10n, hash: blockHash, timestamp: 1_000n },
    getCode: async ({ address }) =>
      address.toLowerCase() ===
      manifest.contracts.thresholdAuthority.toLowerCase()
        ? ACTIVATION_AUTHORITY_RUNTIME
        : artifact("AgentPoolV44MaturityAnchor").deployedBytecode,
    readContract: async ({ functionName }) => {
      if (functionName === "AUTHORITY") {
        return manifest.contracts.thresholdAuthority;
      }
      if (functionName === "getOwners") return ACTIVATION_OWNERS;
      if (functionName === "getThreshold") return 2n;
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  };
  const providers = await Promise.all(
    ["a", "b"].map((name) =>
      collectMaturityAuthorizationPublicationSnapshot({
        rpcUrl: `https://${name}.example`,
        deployment: manifest,
        authorization,
        providerOperatorId: `rpc-${name}`,
        client,
      }),
    ),
  );
  const reconciled = reconcileMaturityAuthorizationPublicationSnapshots({
    providers,
    providerOperatorPolicy: {
      configurationStatus: "ACTIVE",
      providers: ["a", "b"].map((name) => ({
        operatorId: `rpc-${name}`,
        allowedOrigins: [`https://${name}.example`],
        custodyDomainId: `custody-${name}`,
      })),
    },
  });
  assert.equal(reconciled.publication.authorizationId, eventArgs.authorizationId);
  await assert.rejects(
    collectMaturityAuthorizationPublicationSnapshot({
      rpcUrl: "https://a.example",
      deployment: manifest,
      authorization,
      providerOperatorId: "rpc-a",
      client: {
        ...client,
        getTransaction: async () => ({
          to: manifest.contracts.thresholdAuthority,
          input: authorityInput(["0x01"]),
        }),
      },
    }),
    /V44_MATURITY_AUTHORITY_EXECUTION_INVALID/u,
  );
});

async function governanceDryRunFixture(manifest) {
  const checkPolicy = structuredClone(
    loadReliabilityPolicy().policy.autonomyV2.maturityAuthorizationPolicy
      .readinessEvidencePolicy.governanceDryRun.checkPolicy,
  );
  const records = new Map();
  const dryRunJobId = `0x${"41".repeat(32)}`;
  const issue = {
    issueId: `0x${"42".repeat(32)}`,
    bootstrapProposer: "0x0000000000000000000000000000000000000000",
    specificationHash: `0x${"43".repeat(32)}`,
    verifier: manifest.contracts.objectiveVerifier,
    expectedEvidenceHash: `0x${"44".repeat(32)}`,
    objectiveRoot: `0x${"45".repeat(32)}`,
    validatorRoot: manifest.dynamicValidatorRoot,
    candidateBudgetCap: 100n,
    totalBudgetCap: 1_000n,
    maxCandidates: 5,
    minimumReveals: 3,
    passScoreBps: 8_000,
    minimumValidatorGroups: 2,
    funding: 3,
    expiresAt: 9_999_999n,
  };
  const planHash = `0x${"46".repeat(32)}`;
  const releaseId = `0x${"47".repeat(32)}`;
  const needEvidenceHash = `0x${"48".repeat(32)}`;
  const voteEvidenceHash = `0x${"49".repeat(32)}`;
  const salt = `0x${"4a".repeat(32)}`;
  const proposalId = 1n;
  const budget = 10n;
  const gateAbi = artifact(CONTRACT_TYPES.systemIssueGate).abi;
  const hashIssueInput = gateAbi.find(
    (entry) => entry.type === "function" && entry.name === "hashIssue",
  ).inputs[0];
  const issueTermsHash = keccak256(
    encodeAbiParameters([hashIssueInput], [issue]),
  );
  const eventLog = (contractKey, eventName, args, logIndex = 0) => {
    const abi = artifact(CONTRACT_TYPES[contractKey]).abi;
    const event = abi.find(
      (entry) => entry.type === "event" && entry.name === eventName,
    );
    return {
      address: manifest.contracts[contractKey],
      topics: encodeEventTopics({ abi: [event], eventName, args }),
      data: encodeAbiParameters(
        event.inputs.filter((input) => !input.indexed),
        event.inputs
          .filter((input) => !input.indexed)
          .map((input) => args[input.name]),
      ),
      logIndex,
    };
  };
  const milestoneTerms = [{
    worker: OBSERVER_ACCOUNTS[0].address,
    verifier: manifest.contracts.objectiveVerifier,
    capability: `0x${"4b".repeat(32)}`,
    specificationHash: issue.specificationHash,
    expectedEvidenceHash: issue.expectedEvidenceHash,
    payoutRoot: `0x${"4c".repeat(32)}`,
    allocation: budget,
    workerBond: 1n,
    keeperFee: 0n,
    deadline: 9_999_998n,
    capacityUnits: 1,
    minimumReveals: 3,
    passScoreBps: 8_000,
    commitWindow: 60,
    revealWindow: 60,
  }];
  const validationPolicies = [{
    validatorRoot: manifest.dynamicValidatorRoot,
    minimumOperatorGroups: 2,
  }];
  const calls = {
    "proposal-bond-funded": {
      args: [manifest.contracts.transitionIssueConsensus, 100n],
      logs: [],
    },
    "transition-issue-proposed": {
      args: [issue, needEvidenceHash, 100n, 1_000_000n, 2_000_000n],
      logs: [eventLog("transitionIssueConsensus", "IssueProposed", {
        proposalId,
        issueHash: issueTermsHash,
        proposer: OBSERVER_ACCOUNTS[0].address,
        needEvidenceHash,
      })],
    },
    "transition-vote-revealed": {
      args: [proposalId, true, voteEvidenceHash, salt],
      logs: [eventLog("transitionIssueConsensus", "VoteRevealed", {
        proposalId,
        voter: OBSERVER_ACCOUNTS[1].address,
        support: true,
        evidenceHash: voteEvidenceHash,
        weight: 1n,
      })],
    },
    "transition-issue-finalized": {
      args: [proposalId],
      logs: [eventLog("systemIssueGate", "TransitionIssueApproved", {
        issueHash: issueTermsHash,
      })],
    },
    "recovery-job-created": {
      args: [
        3,
        budget,
        planHash,
        releaseId,
        issue,
        [],
        milestoneTerms,
        validationPolicies,
        [0],
        [[]],
      ],
      logs: [eventLog("taskMarket", "JobCreated", {
        jobId: dryRunJobId,
        creator: OBSERVER_ACCOUNTS[0].address,
        funding: 3,
        budget,
        releaseId,
        planHash,
        issueId: issue.issueId,
      })],
    },
    "recovery-refund-and-conservation": {
      args: [dryRunJobId, 0],
      logs: [eventLog("taskMarket", "JobClosed", {
        jobId: dryRunJobId,
        state: 7,
        paid: 0n,
        returnedOrReleased: budget,
      })],
    },
  };
  const locators = checkPolicy.map((check, index) => {
    const transactionHash = `0x${(index + 150)
      .toString(16)
      .padStart(64, "0")}`;
    const functionEntry = artifact(CONTRACT_TYPES[check.contractKey]).abi.find(
      (entry) => entry.type === "function" && entry.name === check.functionName,
    );
    const input = encodeFunctionData({
      abi: [functionEntry],
      functionName: check.functionName,
      args: calls[check.id].args,
    });
    const blockNumber = BigInt(80 + index);
    const blockHash = `0x${(index + 180).toString(16).padStart(64, "0")}`;
    records.set(transactionHash, {
      transaction: { to: manifest.contracts[check.contractKey], input },
      receipt: {
        status: check.expectedStatus,
        blockNumber,
        blockHash,
        transactionIndex: 0,
        logs: calls[check.id].logs,
      },
    });
    return { id: check.id, transactionHash };
  });
  const client = {
    getTransaction: async ({ hash }) => records.get(hash).transaction,
    getTransactionReceipt: async ({ hash }) => records.get(hash).receipt,
    getBlock: async ({ blockNumber }) => {
      const record = [...records.values()].find(
        (entry) => entry.receipt.blockNumber === blockNumber,
      );
      return { number: blockNumber, hash: record.receipt.blockHash };
    },
    readContract: async ({ functionName, args }) => {
      if (functionName === "minimumBond") return 100n;
      if (functionName === "hashIssue") return issueTermsHash;
      if (functionName === "jobs" && args[0].toLowerCase() === dryRunJobId) {
        return [
          OBSERVER_ACCOUNTS[0].address,
          3,
          7,
          planHash,
          releaseId,
          issue.issueId,
          budget,
          0n,
          0,
          1,
          1n,
        ];
      }
      throw new Error(`UNEXPECTED_DRY_RUN_READ:${functionName}`);
    },
  };
  const trustedChecks = await collectGovernanceDryRunChecks({
    client,
    deployment: manifest,
    transcript: { finalizedBlockNumber: 100, checks: locators },
    checkPolicy,
    maximumFinalizedBlockNumber: 100,
  });
  return {
    checkPolicy,
    records,
    dryRunJobId,
    issue,
    issueTermsHash,
    transcript: {
      schema: "agentpool.v44.governance-dry-run/v2",
      verifierVersion: "agentpool-v44-governance-dry-run-v2",
      deploymentManifestSha256: manifest.manifestSha256,
      finalizedBlockNumber: 100,
      transactionCount: trustedChecks.length,
      result: "PASS",
      checks: trustedChecks,
    },
  };
}

test("maturity readiness is independently collected at the finalized block", async () => {
  const manifest = deployment();
  const outputRoot = path.join(ROOT, "outputs");
  fs.mkdirSync(outputRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(outputRoot, "readiness-test-"));
  const transcriptPath = path.join(directory, "dry-run.json");
  const {
    transcript,
    checkPolicy,
    records,
    dryRunJobId,
    issue: dryRunIssue,
    issueTermsHash: dryRunIssueTermsHash,
  } =
    await governanceDryRunFixture(manifest);
  fs.writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
  const fileSha256 = (filePath) =>
    crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  const issueId = `0x${"61".repeat(32)}`;
  const termsHash = `0x${"62".repeat(32)}`;
  const maturityPolicy = {
    configurationStatus: "ACTIVE",
    minimumRecoveryAvailabilitySeconds: 2_592_000,
    readinessEvidencePolicy: {
      proposalBond: {
        tokenContractKey: "token",
        owner: "0x1000000000000000000000000000000000000001",
        spenderContractKey: "issueConsensus",
        requiredAmountWei: "100",
      },
      recoveryIssue: {
        issueId,
        termsHash,
        issueTerms: { issueId, expiresAt: 4_000_000 },
      },
      governanceDryRun: {
        transcriptPath: null,
        transcriptSha256: null,
        verifierPath: "scripts/lib/v44-governance-dry-run.mjs",
        verifierSha256: fileSha256(
          path.join(ROOT, "scripts/lib/v44-governance-dry-run.mjs"),
        ),
        checkPolicy,
      },
      maintainerAgents: [],
    },
  };
  const readinessObservations = {
    incidents: [],
    maturityReadinessEvidence: {
      governanceDryRun: {
        transcriptPath: path.relative(ROOT, transcriptPath),
        transcriptSha256: fileSha256(transcriptPath),
      },
    },
  };
  const blockHash = `0x${"aa".repeat(32)}`;
  const readContract = async ({ functionName, args = [] }) => {
    if (
      functionName === "balanceOf" ||
      functionName === "allowance" ||
      functionName === "minimumBond"
    )
      return 100n;
    if (functionName === "hashIssue") {
      return args[0]?.issueId?.toLowerCase?.() ===
        dryRunIssue.issueId.toLowerCase()
        ? dryRunIssueTermsHash
        : termsHash;
    }
    if (functionName === "usage") return [`0x${"00".repeat(32)}`, 0n, 0];
    if (functionName === "transitionApprovedIssueHash") return true;
    if (functionName === "approvedIssueHash") return false;
    if (functionName === "jobs") {
      if (args[0]?.toLowerCase?.() === dryRunJobId) {
        return [
          OBSERVER_ACCOUNTS[0].address,
          1,
          7,
          `0x${"00".repeat(32)}`,
          `0x${"00".repeat(32)}`,
          `0x${"00".repeat(32)}`,
          10n,
          0n,
          0,
          1,
          1n,
        ];
      }
      return [
        maturityPolicy.readinessEvidencePolicy.proposalBond.owner,
        1,
        1,
        `0x${"01".repeat(32)}`,
        `0x${"02".repeat(32)}`,
        `0x${"00".repeat(32)}`,
        1n,
        0n,
        0,
        1,
        1n,
      ];
    }
    if (functionName === "milestones") {
      return [
        OBSERVER_ACCOUNTS[0].address,
        OBSERVER_ACCOUNTS[1].address,
        `0x${"03".repeat(32)}`,
        `0x${"04".repeat(32)}`,
        `0x${"05".repeat(32)}`,
        `0x${"06".repeat(32)}`,
        `0x${"00".repeat(32)}`,
        1n,
        0n,
        0n,
        4_000_000n,
        1,
        3,
        8_000,
        60,
        60,
        1,
        false,
        false,
      ];
    }
    if (functionName === "jobGovernanceEligible") return false;
    if (functionName === "governanceSnapshotEpoch") return 1n;
    throw new Error(`UNEXPECTED_READ:${functionName}`);
  };
  const readinessClient = {
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === "finalized" || blockNumber === 100n) {
        return { number: 100n, hash: blockHash, timestamp: 1_000n };
      }
      const record = [...records.values()].find(
        (entry) => entry.receipt.blockNumber === blockNumber,
      );
      return {
        number: blockNumber,
        hash: record.receipt.blockHash,
        timestamp: 900n,
      };
    },
    getTransaction: async ({ hash }) => records.get(hash).transaction,
    getTransactionReceipt: async ({ hash }) => records.get(hash).receipt,
    readContract,
  };
  const evidence = await collectMaturityReadinessEvidence({
    rpcUrl: "https://a.example",
    deployment: manifest,
    maturityPolicy,
    observations: readinessObservations,
    trustedProviderSnapshot: {
      origin: "https://a.example",
      finalizedBlockNumber: 100,
      finalizedBlockHash: blockHash,
      chainSnapshot: { governanceSnapshotEpoch: 1 },
    },
    client: readinessClient,
  });
  assert.equal(evidence.proposalBond.balance, "100");
  assert.equal(evidence.proposalBond.onchainMinimumBond, "100");
  assert.equal(evidence.recoveryIssue.state, "AVAILABLE");
  assert.equal(evidence.governanceDryRun.passed, true);
  const reusedTransactionTranscript = structuredClone(transcript);
  reusedTransactionTranscript.checks.at(-1).transactionHash =
    reusedTransactionTranscript.checks[0].transactionHash;
  await assert.rejects(
    collectGovernanceDryRunChecks({
      client: readinessClient,
      deployment: manifest,
      transcript: reusedTransactionTranscript,
      checkPolicy,
      maximumFinalizedBlockNumber: 100,
    }),
    /V44_MATURITY_DRY_RUN_TRANSACTION_REUSED/u,
  );
  const expiredIssuePolicy = structuredClone(maturityPolicy);
  expiredIssuePolicy.readinessEvidencePolicy.recoveryIssue.issueTerms.expiresAt =
    2_000_000;
  const expiredIssueEvidence = await collectMaturityReadinessEvidence({
    rpcUrl: "https://a.example",
    deployment: manifest,
    maturityPolicy: expiredIssuePolicy,
    observations: readinessObservations,
    trustedProviderSnapshot: {
      origin: "https://a.example",
      finalizedBlockNumber: 100,
      finalizedBlockHash: blockHash,
      chainSnapshot: { governanceSnapshotEpoch: 1 },
    },
    client: readinessClient,
  });
  assert.equal(expiredIssueEvidence.recoveryIssue.state, "UNAVAILABLE");
  assert.equal(
    reconcileMaturityReadinessEvidence([evidence, structuredClone(evidence)])
      .providerCount,
    2,
  );
  await assert.rejects(
    collectMaturityReadinessEvidence({
      rpcUrl: "https://a.example",
      deployment: manifest,
      maturityPolicy,
      observations: readinessObservations,
      trustedProviderSnapshot: {
        origin: "https://a.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: blockHash,
        chainSnapshot: { governanceSnapshotEpoch: 2 },
      },
      client: readinessClient,
    }),
    /V44_MATURITY_GOVERNANCE_EPOCH_MISMATCH/u,
  );
  await assert.rejects(
    collectMaturityReadinessEvidence({
      rpcUrl: "https://a.example",
      deployment: manifest,
      maturityPolicy,
      observations: readinessObservations,
      trustedProviderSnapshot: {
        origin: "https://a.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: blockHash,
        chainSnapshot: { governanceSnapshotEpoch: 1 },
      },
      client: {
        ...readinessClient,
        readContract: async (request) =>
          request.functionName === "minimumBond"
            ? 101n
            : readContract(request),
      },
    }),
    /V44_MATURITY_PROPOSAL_BOND_MISMATCH/u,
  );
  const conservationCheck = transcript.checks.find(
    (check) => check.id === "recovery-refund-and-conservation",
  );
  const conservationRecord = records.get(conservationCheck.transactionHash);
  const originalConservationData = conservationRecord.receipt.logs[0].data;
  conservationRecord.receipt.logs[0].data = encodeAbiParameters(
    [
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [7, 0n, 2n],
  );
  await assert.rejects(
    collectMaturityReadinessEvidence({
      rpcUrl: "https://a.example",
      deployment: manifest,
      maturityPolicy,
      observations: readinessObservations,
      trustedProviderSnapshot: {
        origin: "https://a.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: blockHash,
        chainSnapshot: { governanceSnapshotEpoch: 1 },
      },
      client: readinessClient,
    }),
    /V44_MATURITY_DRY_RUN_FUND_CONSERVATION_INVALID/u,
  );
  conservationRecord.receipt.logs[0].data = originalConservationData;
  const fabricated = {
    ...transcript,
    checks: transcript.checks.map((check) => ({
      id: check.id,
      passed: true,
      evidence: `${check.id}-string`,
    })),
  };
  fs.writeFileSync(transcriptPath, `${JSON.stringify(fabricated, null, 2)}\n`);
  const fabricatedObservations = structuredClone(readinessObservations);
  fabricatedObservations.maturityReadinessEvidence.governanceDryRun.transcriptSha256 =
    fileSha256(transcriptPath);
  await assert.rejects(
    collectMaturityReadinessEvidence({
      rpcUrl: "https://a.example",
      deployment: manifest,
      maturityPolicy,
      observations: fabricatedObservations,
      trustedProviderSnapshot: {
        origin: "https://a.example",
        finalizedBlockNumber: 100,
        finalizedBlockHash: blockHash,
        chainSnapshot: { governanceSnapshotEpoch: 1 },
      },
      client: readinessClient,
    }),
    /V44_MATURITY_DRY_RUN_TRANSACTION_INVALID/u,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an unfinalized maturity snapshot is rejected", async () => {
  const manifest = deployment();
  const blockHash = `0x${"aa".repeat(32)}`;
  await assert.rejects(
    collectMaturityProviderSnapshot({
      rpcUrl: "https://rpc-a.example",
      deployment: manifest,
      authorization: {
        providerSnapshots: [
          {
            origin: "https://rpc-a.example",
            providerOperatorId: "rpc-a",
            finalizedBlockNumber: 100,
            finalizedBlockHash: blockHash,
            snapshot: {
              nonMaintainerVotingAgents: [
                { agent: OBSERVER_ACCOUNTS[0].address },
              ],
            },
          },
        ],
      },
      client: {
        getBlock: async ({ blockTag }) =>
          blockTag === "finalized"
            ? { number: 99n, hash: `0x${"bb".repeat(32)}` }
            : { number: 100n, hash: blockHash },
        readContract: async () => 0n,
      },
    }),
    /V44_MATURITY_COLLECTION_BLOCK_MISMATCH/u,
  );
});

test("maturity Work Power population is reconstructed from all finalized outcomes", async () => {
  const manifest = deployment();
  const blockHash = `0x${"ab".repeat(32)}`;
  const agents = OBSERVER_ACCOUNTS.slice(0, 2).map((account) =>
    account.address.toLowerCase(),
  );
  const snapshot = await collectMaturityProviderSnapshot({
    rpcUrl: "https://rpc-a.example",
    deployment: manifest,
    authorization: {
      providerSnapshots: [
        {
          origin: "https://rpc-a.example",
          providerOperatorId: "rpc-a",
          finalizedBlockNumber: 100,
          finalizedBlockHash: blockHash,
          snapshot: {
            nonMaintainerVotingAgents: [{ agent: agents[0] }],
          },
        },
      ],
    },
    maturityPolicy: { readinessEvidencePolicy: { maintainerAgents: [] } },
    client: {
      getBlock: async ({ blockTag }) =>
        blockTag === "finalized"
          ? { number: 100n, hash: blockHash }
          : { number: 100n, hash: blockHash },
      getLogs: async () =>
        agents.map((agent) => ({ args: { agent, successful: true } })),
      readContract: async ({ functionName, args = [] }) => {
        if (functionName === "successfulSettlementCount") return 49n;
        if (functionName === "eligibleAgentCount") return 2n;
        if (functionName === "eligibleGroupCount") return 2n;
        if (functionName === "governanceSnapshotEpoch") return 7n;
        if (functionName === "operatorGroup") {
          return args[0].toLowerCase() === agents[0]
            ? OBSERVER_GROUPS[0]
            : OBSERVER_GROUPS[1];
        }
        if (functionName === "votingPowerAt") {
          assert.equal(args[1], 7n);
          return args[0].toLowerCase() === agents[0] ? 10n : 90n;
        }
        throw new Error(`UNEXPECTED_READ:${functionName}`);
      },
    },
  });
  assert.equal(snapshot.chainSnapshot.populationComplete, true);
  assert.equal(snapshot.chainSnapshot.governanceSnapshotEpoch, 7);
  assert.equal(snapshot.chainSnapshot.positiveVotingAgentCount, 2);
  assert.equal(snapshot.chainSnapshot.totalWorkPower, "100");
  assert.deepEqual(
    snapshot.chainSnapshot.votingAgents.map((agent) => agent.agent),
    [...agents].sort(),
  );
});

test("every mature approval is checked against its own proposal snapshot epoch", async () => {
  const manifest = deployment();
  const agents = ["41", "42", "43", "44", "45"].map((byte) =>
    privateKeyToAccount(`0x${byte.repeat(32)}`).address.toLowerCase(),
  );
  const groups = [0, 1, 2, 0, 1].map(
    (index) => `0x${(index + 1).toString(16).repeat(64)}`,
  );
  const issueHash = `0x${"91".repeat(32)}`;
  const proposalId = 7n;
  const issueConsensusAbi = artifact("AgentPoolV432IssueConsensus").abi;
  const issueGateAbi = artifact("AgentPoolV435SystemIssueGate").abi;
  const receipt = {
    blockNumber: 200n,
    transactionHash: `0x${"92".repeat(32)}`,
    logs: [
      {
        address: manifest.contracts.issueConsensus,
        topics: encodeEventTopics({
          abi: issueConsensusAbi,
          eventName: "ProposalClosed",
          args: { proposalId },
        }),
        data: encodeAbiParameters([{ type: "uint8" }], [3]),
      },
      {
        address: manifest.contracts.systemIssueGate,
        topics: encodeEventTopics({
          abi: issueGateAbi,
          eventName: "MatureIssueApproved",
          args: { issueHash },
        }),
        data: "0x",
      },
    ],
  };
  const maturityPolicy = {
    configurationStatus: "ACTIVE",
    minimumNonMaintainerVotingAgents: 5,
    minimumOnchainGroups: 3,
    minimumCorroboratedControlDomains: 3,
    maximumControlDomainShareBps: 2_999,
    agentControlDomainBindings: agents.map((agent, index) => ({
      agent,
      controllerDomainId: `controller-${index}`,
      custodyDomainId: `custody-${index}`,
      corroborationEvidenceHash: `0x${(index + 1)
        .toString(16)
        .padStart(64, "0")}`,
    })),
    readinessEvidencePolicy: { maintainerAgents: [] },
  };
  const observedEpochs = [];
  const read = async (key, functionName, args = []) => {
    if (key === "issueConsensus" && functionName === "proposals") {
      return [
        agents[0],
        issueHash,
        8n,
        0n,
        0n,
        1n,
        100n,
        0n,
        5,
        3,
        3,
      ];
    }
    if (key === "contributionLedger" && functionName === "operatorGroup") {
      return groups[agents.indexOf(args[0].toLowerCase())];
    }
    if (key === "contributionLedger" && functionName === "votingPowerAt") {
      observedEpochs.push(args[1]);
      return 20n;
    }
    throw new Error(`UNEXPECTED_READ:${key}.${functionName}`);
  };
  const client = {
    getLogs: async () =>
      agents.map((agent) => ({ args: { agent, successful: true } })),
  };
  const evidence = await verifyMatureApprovalPopulation({
    client,
    deployment: manifest,
    maturityPolicy,
    proposalId,
    receipt,
    read,
  });
  assert.equal(evidence.snapshotEpoch, 8);
  assert.equal(evidence.positiveVotingAgentCount, 5);
  assert.equal(evidence.controlDomainCount, 5);
  assert.deepEqual(observedEpochs, Array(5).fill(8n));

  await assert.rejects(
    verifyMatureApprovalPopulation({
      client,
      deployment: manifest,
      maturityPolicy,
      proposalId,
      receipt,
      read: async (key, functionName, args = []) => {
        if (
          key === "contributionLedger" &&
          functionName === "votingPowerAt"
        ) {
          return args[0].toLowerCase() === agents[0] ? 80n : 5n;
        }
        return read(key, functionName, args);
      },
    }),
    /V44_MATURE_APPROVAL_WORK_POWER_INVALID/u,
  );
});

test("an expired JobClosed event cannot be relabeled as a preserved rejection", () => {
  const manifest = deployment();
  const jobId = `0x${"77".repeat(32)}`;
  const abi = artifact("AgentPoolV432TaskMarket").abi;
  const receipt = {
    logs: [
      {
        address: manifest.contracts.taskMarket,
        topics: encodeEventTopics({
          abi,
          eventName: "JobClosed",
          args: { jobId },
        }),
        data: encodeAbiParameters(
          [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [7, 0n, 1n],
        ),
      },
    ],
  };
  assert.throws(
    () =>
      assertClosedJobSemantic({
        category: "REJECTION_PRESERVED",
        decodedFunction: { args: [jobId, 0] },
        receipt,
        deployment: manifest,
      }),
    /V44_TESTNET_JOB_CLOSE_STATE_INVALID:REJECTION_PRESERVED/u,
  );
});

test("an unrelated reverted TaskMarket call cannot claim issue replay protection", async () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const rule = policyEvidence.policy.categories.ISSUE_REPLAY_REJECTED;
  const abi = artifact("AgentPoolV432TaskMarket").abi;
  await assert.rejects(
    verifyObservationSemantic({
      client: {},
      deployment: manifest,
      entry: { category: "ISSUE_REPLAY_REJECTED" },
      rule,
      receipt: { blockNumber: 10n, logs: [] },
      transaction: {
        from: OBSERVER_ACCOUNTS[0].address,
        to: manifest.contracts.taskMarket,
        input: encodeFunctionData({
          abi,
          functionName: "refundExpired",
          args: [`0x${"88".repeat(32)}`, 0],
        }),
      },
      read: async () => {
        throw new Error("unexpected read");
      },
    }),
    /V44_TESTNET_FUNCTION_MISMATCH:ISSUE_REPLAY_REJECTED/u,
  );
});

test("an underfunded system job cannot impersonate an epoch cap rejection", async () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const rule = policyEvidence.policy.categories.CAP_BYPASS_REJECTED;
  const { input } = systemJobInput({
    budget: 9n,
    allocation: 10n,
  });
  const replayBlocks = [];
  await assert.rejects(
    verifyObservationSemantic({
      client: revertedClient("BudgetExceeded", replayBlocks),
      deployment: manifest,
      entry: { category: "CAP_BYPASS_REJECTED" },
      rule,
      receipt: { blockNumber: 10n, logs: [] },
      transaction: {
        from: OBSERVER_ACCOUNTS[0].address,
        to: manifest.contracts.taskMarket,
        input,
      },
      read: async () => {
        throw new Error("unexpected read");
      },
    }),
    /V44_TESTNET_CAP_PROBE_INVALID/u,
  );
  assert.deepEqual(replayBlocks, [9n]);
});

test("an Issue budget rejection cannot impersonate an epoch cap rejection", async () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const rule = policyEvidence.policy.categories.CAP_BYPASS_REJECTED;
  const { input, issue } = systemJobInput({
    budget: 10n,
    allocation: 10n,
    candidateBudgetCap: 9n,
  });
  const termsHash = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: artifact("AgentPoolV432TaskMarket").abi.find(
            (entry) =>
              entry.type === "function" &&
              entry.name === "createSystemJobV2",
          ).inputs[4].components,
        },
      ],
      [issue],
    ),
  );
  const group = `0x${"6c".repeat(32)}`;
  const read = async (key, functionName) => {
    if (key === "systemIssueGate" && functionName === "hashIssue") {
      return termsHash;
    }
    if (key === "systemIssueGate" && functionName === "usage") {
      return [termsHash, 0n, 0];
    }
    if (
      key === "systemIssueGate" &&
      functionName === "transitionApprovedIssueHash"
    ) {
      return true;
    }
    if (
      key === "systemIssueGate" &&
      functionName === "approvedIssueHash"
    ) {
      return false;
    }
    if (key === "systemIssueGate" && functionName === "groupUsed") {
      return false;
    }
    if (
      key === "contributionLedger" &&
      functionName === "operatorGroup"
    ) {
      return group;
    }
    throw new Error(`unexpected read: ${key}.${functionName}`);
  };
  await assert.rejects(
    verifyObservationSemantic({
      client: revertedClient("BudgetExceeded"),
      deployment: manifest,
      entry: { category: "CAP_BYPASS_REJECTED" },
      rule,
      receipt: { blockNumber: 10n, logs: [] },
      transaction: {
        from: OBSERVER_ACCOUNTS[0].address,
        to: manifest.contracts.taskMarket,
        input,
      },
      read,
    }),
    /V44_TESTNET_CAP_PROBE_GATE_PRECONDITION_INVALID/u,
  );
});

test("different Issue terms cannot impersonate a finalized Issue replay", async () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const rule = policyEvidence.policy.categories.ISSUE_REPLAY_REJECTED;
  const { input } = systemJobInput();
  const group = `0x${"6d".repeat(32)}`;
  const actualTermsHash = `0x${"6e".repeat(32)}`;
  const storedTermsHash = `0x${"6f".repeat(32)}`;
  const read = async (key, functionName) => {
    if (
      key === "contributionLedger" &&
      functionName === "operatorGroup"
    ) {
      return group;
    }
    if (key === "systemIssueGate" && functionName === "hashIssue") {
      return actualTermsHash;
    }
    if (key === "systemIssueGate" && functionName === "usage") {
      return [storedTermsHash, 10n, 1];
    }
    if (
      key === "systemIssueGate" &&
      functionName === "candidateFinalized"
    ) {
      return true;
    }
    throw new Error(`unexpected read: ${key}.${functionName}`);
  };
  await assert.rejects(
    verifyObservationSemantic({
      client: revertedClient("DuplicateGroup"),
      deployment: manifest,
      entry: { category: "ISSUE_REPLAY_REJECTED" },
      rule,
      receipt: { blockNumber: 10n, logs: [] },
      transaction: {
        from: OBSERVER_ACCOUNTS[0].address,
        to: manifest.contracts.taskMarket,
        input,
      },
      read,
    }),
    /V44_TESTNET_ISSUE_REPLAY_STATE_INVALID/u,
  );
});

test("observer groups come from the deployment registry, not signer claims", async () => {
  const policyEvidence = loadReliabilityPolicy();
  activateObserverIndependencePolicy(policyEvidence.policy);
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  const unregistered = [
    privateKeyToAccount(`0x${"44".repeat(32)}`),
    privateKeyToAccount(`0x${"55".repeat(32)}`),
  ];
  const message = observationAttestationMessage(ledger);
  ledger.attestations = await Promise.all(
    unregistered.map(async (account, index) => ({
      observer: account.address,
      operatorGroup: `0x${(index + 9).toString(16).repeat(64).slice(0, 64)}`,
      signature: await account.signMessage({ message }),
    })),
  );
  await assert.rejects(
    verifyObservationAttestations(
      ledger,
      policyEvidence.policy,
      manifest,
    ),
    /V44_TESTNET_OBSERVER_NOT_REGISTERED/u,
  );
});

test("synthetic or local-only evidence can never approve mainnet", () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  const evidence = completeEvidence(policyEvidence, ledger);
  evidence.rpcEvidence.liveRpcVerified = false;
  const report = evaluateReliability({
    policy: policyEvidence.policy,
    deployment: manifest,
    observations: ledger,
    sourceEvidence: SOURCE_EVIDENCE,
    ...evidence,
  });
  assert.equal(report.eligible, false);
  assert.ok(report.blockers.includes("LIVE_RPC_VERIFICATION_REQUIRED"));
});

test("a hand-written approved reliability JSON cannot clear the deploy path", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-gate-"),
  );
  const reportPath = path.join(directory, "reliability.json");
  const sourcePath = path.join(directory, "missing-source.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schema:
          "agentpool.mainnet.v44.public-testnet-reliability/v1",
        release: "4.4.0-ownerless-mainnet-candidate",
        sourceCommit: SOURCE_COMMIT,
        targetChainId: 8453,
        decision: "approved",
        observedChainId: 84532,
        eligible: true,
        observationWindow: {
          chainEndedAt: "2026-04-01T00:30:00.000Z",
        },
        generatedAt: "2026-04-01T01:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    await assert.rejects(
      verifyPublicTestnetReliabilityGate({
        gateEvidence: {
          evidencePaths: {
            publicTestnetReliability: reportPath,
            finalSourceReproducibility: sourcePath,
          },
        },
        env: {
          V44_TESTNET_DEPLOYMENT_MANIFEST: path.join(
            directory,
            "missing-deployment.json",
          ),
          V44_TESTNET_OBSERVATIONS: path.join(
            directory,
            "missing-observations.json",
          ),
        },
        now: new Date("2026-04-01T01:00:00.000Z"),
      }),
      /V44_TESTNET_RELIABILITY_GATE_RECOMPUTE_MISMATCH/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("production regeneration pins the approved RPC head and separately expires stale evidence", () => {
  const evaluator = source("scripts/lib/v44-testnet-reliability.mjs");
  const generator = source(
    "scripts/generate-v44-public-testnet-reliability.mjs",
  );
  const packageJson = JSON.parse(source("package.json"));
  const mainnetEnvironment = source(".env.v44.mainnet.example");

  assert.match(
    evaluator,
    /verificationBlockNumber:\s*report\.chainCursor\?\.latestBlock/u,
  );
  assert.match(
    evaluator,
    /latestBlock:\s*Number\(verificationBlock\)/u,
  );
  assert.match(
    evaluator,
    /V44_TESTNET_RELIABILITY_GATE_STALE/u,
  );
  assert.match(
    evaluator,
    /V44_TESTNET_RELIABILITY_GATE_INDEXER_STALE/u,
  );
  assert.match(
    evaluator,
    /report\.observationWindow\?\.chainEndedAt/u,
  );
  assert.doesNotMatch(
    evaluator,
    /"releaseRegistry",\s*"recommendedRelease",\s*deployment\.genesisRelease/u,
  );
  assert.match(generator, /AGENTPOOL_V44_TESTNET_RPC_URL/u);
  assert.match(generator, /AGENTPOOL_V44_TESTNET_RPC_URL_2/u);
  assert.match(
    packageJson.scripts["evidence:v4.4:testnet"],
    /--env-file-if-exists=\.env\.v44\.testnet\.local/u,
  );
  assert.match(mainnetEnvironment, /AGENTPOOL_V44_TESTNET_RPC_URL=/u);
  assert.match(mainnetEnvironment, /AGENTPOOL_V44_TESTNET_RPC_URL_2=/u);
});

test("two independent RPC snapshots must reconcile exactly", () => {
  const evidence = {
    liveRpcVerified: true,
    verifiedTransactionCount: 3,
    contributingAgents: ["0x1"],
    contributingOperatorGroups: ["group-a"],
    latestObservedBlock: 100,
    earliestObservedTimestamp: 1,
    latestObservedTimestamp: 2,
    latestBlock: 101,
    indexerLagBlocks: 1,
  };
  assert.throws(
    () =>
      reconcileRpcEvidenceSnapshots({
        primaryUrl: "https://rpc.example/a",
        secondaryUrl: "https://rpc.example/b",
        primary: evidence,
        secondary: evidence,
      }),
    /V44_TESTNET_RPC_PROVIDER_INDEPENDENCE_REQUIRED/u,
  );
  assert.throws(
    () =>
      reconcileRpcEvidenceSnapshots({
        primaryUrl: "https://rpc-one.example",
        secondaryUrl: "https://rpc-two.example",
        primary: evidence,
        secondary: { ...evidence, latestBlock: 102 },
      }),
    /V44_TESTNET_RPC_EVIDENCE_CONFLICT/u,
  );
  const reconciled = reconcileRpcEvidenceSnapshots({
    primaryUrl: "https://rpc-one.example",
    secondaryUrl: "https://rpc-two.example",
    primary: evidence,
    secondary: evidence,
  });
  assert.equal(reconciled.providerCount, 2);
  assert.deepEqual(reconciled.providerOrigins, [
    "https://rpc-one.example",
    "https://rpc-two.example",
  ]);
  assert.match(reconciled.reconciliationRoot, /^[a-f0-9]{64}$/u);
});

test("release entrypoints reject an imported verifier outside the committed tree", () => {
  const committedPaths = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((relativePath) => relativePath.replaceAll("\\", "/")),
  );
  for (const relativePath of [
    "mainnet-v44-testnet-reliability-policy.json",
    "scripts/generate-v44-public-testnet-reliability.mjs",
    "scripts/lib/v44-chain-profile.mjs",
    "scripts/lib/v44-observation-ledger.mjs",
  ]) {
    committedPaths.add(relativePath);
  }
  committedPaths.delete("scripts/lib/v44-testnet-reliability.mjs");
  assert.throws(
    () => assertReleaseDependenciesTracked(committedPaths),
    /V44_RELEASE_DEPENDENCY_UNTRACKED:scripts\/lib\/v44-testnet-reliability\.mjs/u,
  );
});

test("a declared 90-day window cannot hide same-day chain transactions", () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  const evidence = completeEvidence(policyEvidence, ledger);
  evidence.rpcEvidence.earliestObservedTimestamp = Date.parse(
    "2026-03-31T00:00:00.000Z",
  );
  const report = evaluateReliability({
    policy: policyEvidence.policy,
    deployment: manifest,
    observations: ledger,
    sourceEvidence: SOURCE_EVIDENCE,
    ...evidence,
  });
  assert.equal(report.eligible, false);
  assert.ok(report.blockers.includes("OBSERVATION_WINDOW_TOO_SHORT"));
  assert.ok(
    report.blockers.includes("DECLARED_WINDOW_DOES_NOT_MATCH_CHAIN"),
  );
});

test("only fresh, live, independently attested evidence clears policy", () => {
  const policyEvidence = loadReliabilityPolicy();
  const activePolicy = activateAutonomyPolicy(
    structuredClone(policyEvidence.policy),
  );
  const manifest = deployment();
  const ledger = observations(activePolicy, manifest, {
    policySha256: POLICY_HASH,
  });
  const evidence = completeEvidence(
    { policySha256: POLICY_HASH },
    ledger,
  );
  const report = evaluateReliability({
    policy: activePolicy,
    deployment: manifest,
    observations: ledger,
    sourceEvidence: SOURCE_EVIDENCE,
    trustedActivationPublications: trustedActivationPublications(activePolicy),
    ...evidence,
  });
  assert.equal(report.eligible, true);
  assert.equal(report.decision, "approved");
  assert.deepEqual(report.blockers, []);
});

test("public-testnet evidence intake verifies the live receipt before an atomic append", () => {
  const recorder = source("scripts/record-v44-testnet-observation.mjs");
  const incidentRecorder = source(
    "scripts/record-v44-testnet-incident.mjs",
  );
  const attester = source(
    "scripts/attest-v44-testnet-observations.mjs",
  );
  const helper = source("scripts/lib/v44-observation-ledger.mjs");
  const setup = source("scripts/setup-v44-testnet-campaign.mjs");
  assert.match(recorder, /appendTestnetObservation/);
  assert.match(helper, /collectLiveRpcEvidence/);
  assert.match(helper, /next\.attestations = \[\]/);
  assert.ok(
    helper.indexOf("await collectEvidence") <
      helper.lastIndexOf("writeJsonAtomic(context.observationsPath"),
  );
  assert.match(incidentRecorder, /next\.attestations = \[\]/);
  assert.match(attester, /observationAttestationMessage/);
  assert.match(attester, /V44_TESTNET_OBSERVER_PRIVATE_KEY/);
  assert.match(helper, /fs\.renameSync\(temporaryPath, filePath\)/);
  assert.match(setup, /privateKeysCopied: false/);
  assert.match(setup, /Array\.from\(\{ length: 24 \}/);
  assert.match(setup, /requireThresholdAuthorityConfig\(\)/);
  assert.match(setup, /requireAddress\("V44_BOOTSTRAP_WORKER"\)/);
  assert.match(setup, /`V44_BOOTSTRAP_WORKER=\$\{worker\}`/);
  assert.doesNotMatch(
    setup,
    /SET_COMMA_SEPARATED_SORTED_SIGNER_ADDRESSES/,
  );
  assert.match(
    setup,
    /MIN_V44_TESTNET_DEPLOYER_BALANCE_WEI=500000000000000/,
  );
  assert.doesNotMatch(setup, /DEPLOYER_PRIVATE_KEY=.*join/);
});

test("autonomy policy is loaded from the verified campaign policy", () => {
  const reliability = source(
    "scripts/lib/v44-testnet-reliability.mjs",
  );
  assert.match(
    reliability,
    /policyEvidence\.policy\.autonomyV2/u,
  );
  assert.doesNotMatch(
    reliability,
    /const trustedAutonomyPolicy = policy\.autonomyV2/u,
  );
  assert.match(reliability, /evaluationTimeMs: Date\.now\(\)/u);
  const observerAttester = source(
    "scripts/attest-v44-autonomy-observer.mjs",
  );
  assert.match(observerAttester, /const evaluationTimeMs = Date\.now\(\)/u);
  assert.doesNotMatch(observerAttester, /atMs: bundle\.evaluationTimeMs/u);
});

test("an unresolved high-severity invariant incident blocks approval", () => {
  const policyEvidence = loadReliabilityPolicy();
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  ledger.incidents.push({
    severity: "HIGH",
    status: "OPEN",
    invariant: "refund-liveness",
  });
  const report = evaluateReliability({
    policy: policyEvidence.policy,
    deployment: manifest,
    observations: ledger,
    sourceEvidence: SOURCE_EVIDENCE,
    ...completeEvidence(policyEvidence, ledger),
  });
  assert.equal(report.eligible, false);
  assert.ok(report.blockers.includes("UNRESOLVED_CRITICAL_INCIDENTS"));
  assert.equal(report.criticalInvariants["refund-liveness"], false);
});

test("missing public evidence produces a durable blocked report", () => {
  const policyEvidence = loadReliabilityPolicy();
  const report = blockedReliabilityReport({
    policyEvidence,
    contractSourceCommit: SOURCE_COMMIT,
    evidencePipelineCommit: EVIDENCE_PIPELINE_COMMIT,
    blockers: [
      "V44_TESTNET_DEPLOYMENT_MISSING",
      "V44_TESTNET_OBSERVATIONS_MISSING",
    ],
    generatedAt: "2026-04-01T01:00:00.000Z",
  });
  assert.equal(report.eligible, false);
  assert.equal(report.decision, "blocked");
  assert.equal(report.contractSourceCommit, SOURCE_COMMIT);
  assert.equal(report.evidencePipelineCommit, EVIDENCE_PIPELINE_COMMIT);
  assert.equal(
    report.criticalInvariants["bootstrap-work-creates-no-work-power"],
    false,
  );
});
