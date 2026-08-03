import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  recoverMessageAddress,
  toBytes,
  toEventSignature,
} from "viem";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  assertTrackedTreeClean,
  currentGitCommit,
  loadAndValidateConfig,
  merkleCatalog,
  readJson,
  sha256File,
  sha256Json,
} from "./v44-mainnet.mjs";
import {
  PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
  V44_CHAIN_EVENT_SIGNATURES,
  collectGovernanceEventSnapshot,
  sha256Json as sha256AutonomyJson,
  validateAutonomyEvidence,
} from "./v44-autonomy-safety.mjs";
import {
  GOVERNANCE_DRY_RUN_VERIFIER_VERSION,
  REQUIRED_GOVERNANCE_DRY_RUN_CHECKS,
  verifyGovernanceDryRunTranscript,
} from "./v44-governance-dry-run.mjs";

export const TESTNET_CHAIN_ID = 84532;
export const TARGET_CHAIN_ID = 8453;
export const RELIABILITY_SCHEMA =
  "agentpool.mainnet.v44.public-testnet-reliability/v1";
export const POLICY_SCHEMA =
  "agentpool.testnet.v44.reliability-policy/v1";
export const DEPLOYMENT_SCHEMA =
  "agentpool.testnet.v44.deployment/v1";
export const OBSERVATION_SCHEMA =
  "agentpool.testnet.v44.observations/v1";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const POLICY_ANCHOR_DOMAIN = keccak256(
  toBytes("AGENTPOOL_V44_POLICY_ACTIVATION_ANCHOR_V2"),
);
const POLICY_ACTIVATION_ANCHORED_EVENT = {
  type: "event",
  name: "PolicyActivationAnchored",
  inputs: [
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
  ],
};
const THRESHOLD_AUTHORITY_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];
const JOB_STATE = Object.freeze({
  SETTLED: 4,
  REJECTED: 5,
  REFUNDED: 6,
  EXPIRED: 7,
});
const FUNDING = Object.freeze({
  EXTERNAL: 1,
  CORE: 2,
  EVOLUTION: 3,
});
const SEMANTICS = new Set([
  "BOOTSTRAP_SETTLEMENT",
  "SYSTEM_SETTLEMENT",
  "EXTERNAL_SETTLEMENT",
  "JOB_CLOSED_EXPIRED",
  "JOB_CLOSED_NO_QUORUM_REFUND",
  "JOB_CLOSED_REJECTED",
  "FINALIZED_ISSUE_REPLAY",
  "DUPLICATE_SETTLEMENT",
  "EMISSION_CAP_EXCEEDED",
  "TRANSITION_APPROVAL",
  "MATURE_APPROVAL",
  "RELEASE_RECOMMENDATION",
]);

function exactKeys(value, expected, label) {
  const actualKeys = Object.keys(value ?? {}).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`V44_TESTNET_${label}_KEYS_INVALID`);
  }
}

function validatorLeaf(address, operatorGroup) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [getAddress(address), operatorGroup],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [inner]),
  );
}

function requireInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`V44_TESTNET_POLICY_INVALID:${label}`);
  }
}

function validatePinnedSignerPolicy(value, label) {
  if (
    !value ||
    !Number.isSafeInteger(value.threshold) ||
    value.threshold < 2 ||
    !Array.isArray(value.authorizedPublicKeys) ||
    !Array.isArray(value.signerBindings) ||
    new Set(value.authorizedPublicKeys).size !==
      value.authorizedPublicKeys.length ||
    value.authorizedPublicKeys.some(
      (key) =>
        typeof key !== "string" ||
        !key.includes("BEGIN PUBLIC KEY"),
    ) ||
    !["ACTIVE", "PENDING_EXTERNAL_KEYS"].includes(
      value.configurationStatus,
    ) ||
    (value.configurationStatus === "ACTIVE" &&
      (value.authorizedPublicKeys.length < value.threshold ||
        value.signerBindings.length < value.threshold ||
        new Set(
          value.signerBindings.map((binding) => binding.signerKeyId),
        ).size !== value.signerBindings.length ||
        new Set(
          value.signerBindings.map(
            (binding) => binding.controllerDomainId,
          ),
        ).size < value.threshold ||
        new Set(
          value.signerBindings.map((binding) => binding.custodyDomainId),
        ).size < value.threshold ||
        value.signerBindings.some(
          (binding) =>
            !HASH_PATTERN.test(binding.signerKeyId ?? "") ||
            typeof binding.controllerDomainId !== "string" ||
            binding.controllerDomainId.length < 3 ||
            typeof binding.custodyDomainId !== "string" ||
            binding.custodyDomainId.length < 3 ||
            !HASH_PATTERN.test(binding.corroborationEvidenceHash ?? ""),
        ))) ||
    (value.configurationStatus === "PENDING_EXTERNAL_KEYS" &&
      (value.authorizedPublicKeys.length !== 0 ||
        value.signerBindings.length !== 0))
  ) {
    throw new Error(`V44_TESTNET_POLICY_INVALID:${label}`);
  }
}

function validateAutonomyPolicy(autonomy) {
  const exposure = autonomy?.exposurePolicy;
  const governance = autonomy?.governanceEventPolicy;
  const maturity = autonomy?.maturityAuthorizationPolicy;
  const providers = autonomy?.governanceEventProviderPolicy;
  const binding = autonomy?.generatedCodeBinding;
  const expectedSignatures = [
    ...new Set(Object.values(V44_CHAIN_EVENT_SIGNATURES)),
  ].sort();
  const activation = autonomy?.policyActivation;
  const readiness = maturity?.readinessEvidencePolicy;
  if (
    autonomy?.schema !== "agentpool.v44.autonomy-policy/v1" ||
    exposure?.preMatureMaximumSuccessfulSystemSettlements !== 49 ||
    exposure?.maturityTransitionSettlement !== 50 ||
    governance?.fromBlock !== "deployment.deploymentBlock" ||
    JSON.stringify([...(governance?.contractKeys ?? [])].sort()) !==
      JSON.stringify([
        "contributionLedger",
        "issueConsensus",
        "proofRegistry",
        "systemIssueGate",
        "taskMarket",
        "transitionIssueConsensus",
      ]) ||
    JSON.stringify([...(governance?.sourceContractKeys ?? [])].sort()) !==
      JSON.stringify(["settlementRouter"]) ||
    JSON.stringify([...(governance?.eventSignatures ?? [])].sort()) !==
      JSON.stringify(expectedSignatures) ||
    !["ACTIVE", "PENDING_EXTERNAL_PROVIDERS"].includes(
      providers?.configurationStatus,
    ) ||
    !Array.isArray(providers?.providers) ||
    (providers?.configurationStatus === "PENDING_EXTERNAL_PROVIDERS" &&
      providers.providers.length !== 0) ||
    (providers?.configurationStatus === "ACTIVE" &&
      (providers.providers.length < 2 ||
        new Set(providers.providers.map((provider) => provider.operatorId))
          .size !== providers.providers.length ||
        new Set(providers.providers.map((provider) => provider.custodyDomainId))
          .size < 2 ||
        providers.providers.some(
          (provider) =>
            typeof provider.operatorId !== "string" ||
            provider.operatorId.length < 3 ||
            !Array.isArray(provider.allowedOrigins) ||
            provider.allowedOrigins.length < 1 ||
            provider.allowedOrigins.some((origin) => {
              try {
                return new URL(origin).origin !== origin;
              } catch {
                return true;
              }
            }) ||
            typeof provider.custodyDomainId !== "string" ||
            provider.custodyDomainId.length < 3 ||
            !HASH_PATTERN.test(provider.corroborationEvidenceHash ?? ""),
        ))) ||
    !["ACTIVE", "PENDING_EXTERNAL_ANCHOR"].includes(
      activation?.configurationStatus,
    ) ||
    activation?.contractKey !== "policyAnchor" ||
    activation?.restartObservationWindowOnChange !== true ||
    activation?.rotationPolicy !== "NEW_CONTRACT_AND_WINDOW" ||
    (activation?.configurationStatus === "PENDING_EXTERNAL_ANCHOR" &&
      (!Array.isArray(activation.anchorHistory) ||
        activation.anchorHistory.length !== 0 ||
        activation.thresholdAuthority !== null)) ||
    (activation?.configurationStatus === "ACTIVE" &&
      (!Array.isArray(activation.anchorHistory) ||
        activation.anchorHistory.length !== 1 ||
        !isAddress(activation.thresholdAuthority?.address ?? "") ||
        !HASH_PATTERN.test(
          activation.thresholdAuthority?.runtimeCodeHash ?? "",
        ) ||
        !Number.isSafeInteger(activation.thresholdAuthority?.threshold) ||
        activation.thresholdAuthority.threshold < 2 ||
        !Array.isArray(activation.thresholdAuthority?.owners) ||
        activation.thresholdAuthority.owners.length <
          activation.thresholdAuthority.threshold ||
        new Set(
          activation.thresholdAuthority.owners.map((owner) =>
            owner?.toLowerCase?.(),
          ),
        ).size !== activation.thresholdAuthority.owners.length ||
        activation.thresholdAuthority.owners.some(
          (owner) => !isAddress(owner ?? ""),
        ) ||
        !Array.isArray(activation.thresholdAuthority?.ownerBindings) ||
        activation.thresholdAuthority.ownerBindings.length !==
          activation.thresholdAuthority.owners.length ||
        new Set(
          activation.thresholdAuthority.ownerBindings.map((binding) =>
            binding.owner?.toLowerCase?.(),
          ),
        ).size !== activation.thresholdAuthority.ownerBindings.length ||
        new Set(
          activation.thresholdAuthority.ownerBindings.map(
            (binding) => binding.controllerDomainId,
          ),
        ).size < activation.thresholdAuthority.threshold ||
        new Set(
          activation.thresholdAuthority.ownerBindings.map(
            (binding) => binding.custodyDomainId,
          ),
        ).size < activation.thresholdAuthority.threshold ||
        activation.thresholdAuthority.ownerBindings.some(
          (binding) =>
            !activation.thresholdAuthority.owners
              .map((owner) => owner.toLowerCase())
              .includes(binding.owner?.toLowerCase?.()) ||
            typeof binding.controllerDomainId !== "string" ||
            typeof binding.custodyDomainId !== "string" ||
            !HASH_PATTERN.test(binding.corroborationEvidenceHash ?? ""),
        ))) ||
    maturity?.minimumNonMaintainerVotingAgents !== 5 ||
    maturity?.minimumOnchainGroups !== 3 ||
    maturity?.minimumCorroboratedControlDomains !== 3 ||
    !Array.isArray(maturity?.agentControlDomainBindings) ||
    (maturity?.configurationStatus === "PENDING_EXTERNAL_KEYS" &&
      maturity.agentControlDomainBindings.length !== 0) ||
    (maturity?.configurationStatus === "ACTIVE" &&
      (maturity.agentControlDomainBindings.length < 5 ||
        new Set(
          maturity.agentControlDomainBindings.map((binding) =>
            binding.agent?.toLowerCase?.(),
          ),
        ).size !== maturity.agentControlDomainBindings.length ||
        maturity.agentControlDomainBindings.some(
          (binding) =>
            !isAddress(binding.agent ?? "") ||
            typeof binding.controllerDomainId !== "string" ||
            binding.controllerDomainId.length < 3 ||
            typeof binding.custodyDomainId !== "string" ||
            binding.custodyDomainId.length < 3 ||
            !HASH_PATTERN.test(binding.corroborationEvidenceHash ?? ""),
        ))) ||
    maturity?.maximumControlDomainShareBps !== 2_999 ||
    maturity?.maintainerGovernanceUnits !== 0 ||
    maturity?.proposalBondRequired !== true ||
    maturity?.recoveryIssueRequired !== true ||
    maturity?.recoveryJobRequired !== false ||
    maturity?.recoveryMode !== "UNCONSUMED_RECOVERY_ISSUE" ||
    maturity?.maximumUnresolvedCriticalHigh !== 0 ||
    maturity?.governanceDryRunRequired !== true ||
    maturity?.authorizationScope !== "SINGLE_50TH_SYSTEM_SETTLEMENT" ||
    Object.hasOwn(maturity ?? {}, "trustedReadinessEvidence") ||
    readiness?.proposalBond?.tokenContractKey !== "token" ||
    readiness?.proposalBond?.spenderContractKey !== "transitionIssueConsensus" ||
    maturity?.minimumRecoveryAvailabilitySeconds !== 2_592_000 ||
    readiness?.governanceDryRun?.verifierPath !==
      "scripts/lib/v44-governance-dry-run.mjs" ||
    readiness?.governanceDryRun?.verifierVersion !==
      GOVERNANCE_DRY_RUN_VERIFIER_VERSION ||
    JSON.stringify(
      (readiness?.governanceDryRun?.checkPolicy ?? []).map(
        (check) => check.id,
      ),
    ) !== JSON.stringify(REQUIRED_GOVERNANCE_DRY_RUN_CHECKS) ||
    (readiness?.governanceDryRun?.checkPolicy ?? []).some(
      (check) =>
        !(check.contractKey in CONTRACT_TYPES) ||
        typeof check.functionName !== "string" ||
        !["success", "reverted"].includes(check.expectedStatus) ||
        !Array.isArray(check.requiredEvents) ||
        check.requiredEvents.some(
          (event) =>
            !(event.contractKey in CONTRACT_TYPES) ||
            typeof event.signature !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/u.test(event.signature),
        ),
    ) ||
    !Array.isArray(readiness?.maintainerAgents) ||
    new Set(
      readiness.maintainerAgents.map((agent) => agent?.toLowerCase?.()),
    ).size !== readiness.maintainerAgents.length ||
    readiness.maintainerAgents.some((agent) => !isAddress(agent ?? "")) ||
    (maturity?.configurationStatus === "ACTIVE" &&
      (!isAddress(readiness.proposalBond.owner ?? "") ||
        !/^[0-9]+$/u.test(readiness.proposalBond.requiredAmountWei ?? "") ||
        BigInt(readiness.proposalBond.requiredAmountWei) <= 0n ||
        !HASH_PATTERN.test(readiness.recoveryIssue?.issueId ?? "") ||
        !HASH_PATTERN.test(readiness.recoveryIssue?.termsHash ?? "") ||
        typeof readiness.recoveryIssue?.issueTerms !== "object" ||
        readiness.recoveryIssue.issueTerms === null ||
        typeof readiness.governanceDryRun?.transcriptPath !== "string" ||
        readiness.governanceDryRun.transcriptPath.length < 3 ||
        !SHA256_PATTERN.test(
          readiness.governanceDryRun?.transcriptSha256 ?? "",
        ) ||
        !SHA256_PATTERN.test(
          readiness.governanceDryRun?.verifierSha256 ?? "",
        ))) ||
    binding?.sourceCommit !== "evidencePipeline.sourceCommit" ||
    binding?.deploymentManifestSha256 !== "deployment.manifestSha256" ||
    binding?.configSha256 !== "deployment.configSha256"
  ) {
    throw new Error("V44_TESTNET_AUTONOMY_POLICY_INVALID");
  }
  validatePinnedSignerPolicy(
    autonomy.controlDomainPolicy,
    "autonomyV2.controlDomainPolicy",
  );
  validatePinnedSignerPolicy(
    autonomy.checkpointPolicy,
    "autonomyV2.checkpointPolicy",
  );
  validatePinnedSignerPolicy(
    maturity,
    "autonomyV2.maturityAuthorizationPolicy",
  );
}

function requireIso(value, label) {
  if (
    typeof value !== "string" ||
    !ISO_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`V44_TESTNET_${label}_INVALID`);
  }
  return Date.parse(value);
}

function canonicalObservationBody(observations) {
  const body = structuredClone(observations);
  delete body.attestations;
  return body;
}

export function observationAttestationMessage(observations) {
  return [
    "AgentPool v4.4 public testnet observations",
    sha256Json(canonicalObservationBody(observations)),
  ].join("\n");
}

export function autonomySignerSetHash(autonomyPolicy) {
  return sha256Json({
    observerIndependencePolicy:
      autonomyPolicy?.observerIndependencePolicy ?? null,
    controlDomainPolicy: autonomyPolicy?.controlDomainPolicy ?? null,
    checkpointPolicy: autonomyPolicy?.checkpointPolicy ?? null,
    maturityAuthorizationPolicy:
      autonomyPolicy?.maturityAuthorizationPolicy ?? null,
  });
}

export function activationSignerSetHash(activation) {
  return sha256Json({
    authorityAddress:
      activation?.thresholdAuthority?.address?.toLowerCase?.() ?? null,
    runtimeCodeHash:
      activation?.thresholdAuthority?.runtimeCodeHash?.toLowerCase?.() ?? null,
    owners: [...(activation?.thresholdAuthority?.owners ?? [])]
      .map((owner) => owner.toLowerCase())
      .sort(),
    threshold: activation?.thresholdAuthority?.threshold ?? null,
  });
}

export function activationBindingsRoot(activation) {
  return sha256Json(
    [...(activation?.thresholdAuthority?.ownerBindings ?? [])].sort((left, right) =>
      left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()),
    ),
  );
}

export function autonomyPolicyConfigurationHash(autonomyPolicy) {
  return sha256Json({
    schema: autonomyPolicy?.schema ?? null,
    observerIndependencePolicy:
      autonomyPolicy?.observerIndependencePolicy ?? null,
    exposurePolicy: autonomyPolicy?.exposurePolicy ?? null,
    governanceEventPolicy: autonomyPolicy?.governanceEventPolicy ?? null,
    governanceEventProviderPolicy:
      autonomyPolicy?.governanceEventProviderPolicy ?? null,
    controlDomainPolicy: autonomyPolicy?.controlDomainPolicy ?? null,
    checkpointPolicy: autonomyPolicy?.checkpointPolicy ?? null,
    maturityAuthorizationPolicy:
      autonomyPolicy?.maturityAuthorizationPolicy ?? null,
    generatedCodeBinding: autonomyPolicy?.generatedCodeBinding ?? null,
  });
}

function activationAnchorBody(anchor) {
  const body = structuredClone(anchor ?? {});
  delete body.anchorHash;
  delete body.publication;
  delete body.signatures;
  return body;
}

function asBytes32(value, label) {
  if (SHA256_PATTERN.test(value ?? "")) return `0x${value}`;
  if (HASH_PATTERN.test(value ?? "")) return value.toLowerCase();
  throw new Error(`V44_POLICY_ACTIVATION_${label}_INVALID`);
}

function computePolicyAnchorHash(anchor) {
  if (!isAddress(anchor?.policyAnchorAddress ?? "")) {
    throw new Error("V44_POLICY_ACTIVATION_CONTRACT_INVALID");
  }
  return keccak256(
    encodeAbiParameters(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint16",
        "bytes32",
        "bytes20",
        "bytes32",
        "bytes32",
      ].map((type) => ({ type })),
      [
        POLICY_ANCHOR_DOMAIN,
        BigInt(anchor.chainId),
        getAddress(anchor.policyAnchorAddress),
        getAddress(anchor.activationAuthority),
        BigInt(anchor.activationSequence),
        asBytes32(anchor.policyConfigurationHash, "POLICY_HASH"),
        asBytes32(anchor.signerSetHash, "SIGNER_SET_HASH"),
        asBytes32(anchor.activationSignerSetHash, "ACTIVATION_SIGNER_HASH"),
        anchor.activationThreshold,
        asBytes32(anchor.activationBindingsRoot, "BINDINGS_ROOT"),
        `0x${anchor.evidencePipelineCommit}`,
        asBytes32(anchor.previousAnchorHash, "PREVIOUS_HASH"),
        asBytes32(anchor.transparencyLogRoot, "TRANSPARENCY_ROOT"),
      ],
    ),
  );
}

export function createPolicyActivationAnchor({
  policyAnchorAddress,
  activationAuthority,
  policyConfigurationHash,
  signerSetHash,
  activationSignerSetHash: pinnedActivationSignerSetHash,
  activationThreshold,
  activationBindingsRoot: pinnedActivationBindingsRoot,
  evidencePipelineCommit,
  activationSequence,
  previousAnchorHash,
  transparencyLogRoot,
}) {
  const body = {
    schema: "agentpool.v44.policy-activation-anchor/v3",
    chainId: TESTNET_CHAIN_ID,
    policyAnchorAddress: getAddress(policyAnchorAddress).toLowerCase(),
    activationAuthority: getAddress(activationAuthority).toLowerCase(),
    policyConfigurationHash,
    signerSetHash,
    activationSignerSetHash: pinnedActivationSignerSetHash,
    activationThreshold,
    activationBindingsRoot: pinnedActivationBindingsRoot,
    evidencePipelineCommit,
    activationSequence,
    previousAnchorHash,
    transparencyLogRoot,
  };
  return { ...body, anchorHash: computePolicyAnchorHash(body), signatures: [] };
}

export function signPolicyActivationAnchor() {
  throw new Error("V44_POLICY_ACTIVATION_OFFCHAIN_SIGNATURES_UNSUPPORTED");
}

export function validatePolicyActivationAnchor(
  activation,
  {
    expectedPolicyConfigurationHash = null,
    expectedSignerSetHash = null,
    expectedEvidencePipelineCommit = null,
    expectedPolicyAnchorAddress = null,
    trustedPublications = null,
  } = {},
) {
  if (activation?.configurationStatus !== "ACTIVE") {
    return {
      valid: false,
      status: activation?.configurationStatus ?? "PENDING_EXTERNAL_ANCHOR",
      anchor: null,
    };
  }
  if (
    !Array.isArray(activation.anchorHistory) ||
    activation.anchorHistory.length === 0
  ) {
    throw new Error("V44_POLICY_ACTIVATION_ANCHOR_INVALID");
  }
  const expectedActivationSignerSetHash = activationSignerSetHash(activation);
  const expectedActivationBindingsRoot = activationBindingsRoot(activation);
  const publications = new Map(
    (trustedPublications ?? []).map((publication) => [
      publication.anchorHash?.toLowerCase?.(),
      publication,
    ]),
  );
  if (activation.anchorHistory.length !== 1) {
    throw new Error("V44_POLICY_ACTIVATION_ROTATION_REQUIRES_NEW_CONTRACT");
  }
  for (const anchor of activation.anchorHistory) {
    const body = activationAnchorBody(anchor);
    const publication = publications.get(anchor.anchorHash?.toLowerCase?.());
    if (
      anchor?.schema !== "agentpool.v44.policy-activation-anchor/v3" ||
      anchor.chainId !== TESTNET_CHAIN_ID ||
      !isAddress(anchor.policyAnchorAddress ?? "") ||
      anchor.activationAuthority?.toLowerCase?.() !==
        activation.thresholdAuthority.address.toLowerCase() ||
      (expectedPolicyAnchorAddress !== null &&
        anchor.policyAnchorAddress.toLowerCase() !==
          expectedPolicyAnchorAddress.toLowerCase()) ||
      !SHA256_PATTERN.test(anchor.policyConfigurationHash ?? "") ||
      !SHA256_PATTERN.test(anchor.signerSetHash ?? "") ||
      anchor.activationSignerSetHash !== expectedActivationSignerSetHash ||
      anchor.activationThreshold !==
        activation.thresholdAuthority.threshold ||
      anchor.activationBindingsRoot !== expectedActivationBindingsRoot ||
      !/^[0-9a-f]{40}$/u.test(anchor.evidencePipelineCommit ?? "") ||
      anchor.activationSequence !== 1 ||
      anchor.previousAnchorHash !== `0x${"00".repeat(32)}` ||
      !HASH_PATTERN.test(anchor.transparencyLogRoot ?? "") ||
      anchor.anchorHash !== computePolicyAnchorHash(body) ||
      !publication ||
      publication.anchorHash.toLowerCase() !== anchor.anchorHash.toLowerCase() ||
      publication.activationSequence !== anchor.activationSequence ||
      publication.activationAuthority?.toLowerCase?.() !==
        anchor.activationAuthority.toLowerCase() ||
      publication.authorityRuntimeCodeHash?.toLowerCase?.() !==
        activation.thresholdAuthority.runtimeCodeHash.toLowerCase() ||
      publication.authorityThreshold !==
        activation.thresholdAuthority.threshold ||
      sha256Json(publication.authorityOwners ?? []) !==
        sha256Json(
          activation.thresholdAuthority.owners
            .map((owner) => owner.toLowerCase())
            .sort(),
        ) ||
      !HASH_PATTERN.test(publication.blockHash ?? "") ||
      !HASH_PATTERN.test(publication.transactionHash ?? "")
    ) {
      throw new Error("V44_POLICY_ACTIVATION_ANCHOR_INVALID");
    }
    if ((anchor.signatures ?? []).length !== 0) {
      throw new Error("V44_POLICY_ACTIVATION_OFFCHAIN_SIGNATURES_FORBIDDEN");
    }
  }
  const anchor = activation.anchorHistory.at(-1);
  const publication = publications.get(anchor.anchorHash.toLowerCase());
  if (
    (expectedPolicyConfigurationHash !== null &&
      anchor.policyConfigurationHash !== expectedPolicyConfigurationHash) ||
    (expectedSignerSetHash !== null &&
      anchor.signerSetHash !== expectedSignerSetHash) ||
    (expectedEvidencePipelineCommit !== null &&
      anchor.evidencePipelineCommit !== expectedEvidencePipelineCommit)
  ) {
    throw new Error("V44_POLICY_ACTIVATION_ANCHOR_INVALID");
  }
  return { valid: true, status: "ACTIVE", anchor, publication };
}

export function autonomyPolicyIdentity(
  autonomyPolicy,
  evidencePipelineCommit = null,
  { policyAnchorAddress = null, trustedPublications = null } = {},
) {
  const activation = validatePolicyActivationAnchor(
    autonomyPolicy?.policyActivation,
    {
      expectedPolicyConfigurationHash:
        autonomyPolicyConfigurationHash(autonomyPolicy),
      expectedSignerSetHash: autonomySignerSetHash(autonomyPolicy),
      expectedEvidencePipelineCommit: evidencePipelineCommit,
      expectedPolicyAnchorAddress: policyAnchorAddress,
      trustedPublications,
    },
  );
  return {
    signerSetHash: autonomySignerSetHash(autonomyPolicy),
    activatedAt:
      activation.valid === true
        ? new Date(activation.publication.blockTimestampMs).toISOString()
        : null,
    activatedBlock:
      activation.valid === true ? activation.publication.blockNumber : null,
    activationStatus:
      activation.valid === true ? "ACTIVE" : activation.status,
    activationSequence:
      activation.valid === true ? activation.anchor.activationSequence : null,
    activationAnchorHash:
      activation.valid === true ? activation.anchor.anchorHash : null,
  };
}

function canonicalActivationPublication(value) {
  return {
    anchorHash: value.anchorHash.toLowerCase(),
    activationSequence: Number(value.activationSequence),
    policyConfigurationHash: value.policyConfigurationHash.toLowerCase(),
    activationAuthority: value.activationAuthority.toLowerCase(),
    signerSetHash: value.signerSetHash.toLowerCase(),
    activationSignerSetHash: value.activationSignerSetHash.toLowerCase(),
    activationThreshold: Number(value.activationThreshold),
    activationBindingsRoot: value.activationBindingsRoot.toLowerCase(),
    evidencePipelineCommit: value.evidencePipelineCommit.toLowerCase(),
    previousAnchorHash: value.previousAnchorHash.toLowerCase(),
    transparencyLogRoot: value.transparencyLogRoot.toLowerCase(),
    transactionHash: value.transactionHash.toLowerCase(),
    logIndex: Number(value.logIndex),
    blockNumber: Number(value.blockNumber),
    blockHash: value.blockHash.toLowerCase(),
    blockTimestampMs: Number(value.blockTimestampMs),
    authorityRuntimeCodeHash: value.authorityRuntimeCodeHash.toLowerCase(),
    authorityOwners: [...value.authorityOwners]
      .map((owner) => owner.toLowerCase())
      .sort(),
    authorityThreshold: Number(value.authorityThreshold),
  };
}

export async function collectPolicyActivationPublicationSnapshot({
  rpcUrl,
  deployment,
  activation,
  providerOperatorId,
  client: suppliedClient = null,
}) {
  if (
    activation?.configurationStatus !== "ACTIVE" ||
    !isAddress(deployment?.contracts?.policyAnchor ?? "") ||
    typeof providerOperatorId !== "string" ||
    providerOperatorId.length < 3
  ) {
    throw new Error("V44_POLICY_ACTIVATION_COLLECTION_INPUT_INVALID");
  }
  const origin = new URL(rpcUrl).origin;
  const client =
    suppliedClient ?? createPublicClient({ transport: http(rpcUrl) });
  const finalizedHead = await client.getBlock({ blockTag: "finalized" });
  const policyAnchorAddress = getAddress(deployment.contracts.policyAnchor);
  const authorityAddress = getAddress(deployment.contracts.thresholdAuthority);
  if (
    activation.thresholdAuthority.address.toLowerCase() !==
    authorityAddress.toLowerCase()
  ) {
    throw new Error("V44_POLICY_ACTIVATION_AUTHORITY_MISMATCH");
  }
  const expectedRuntimeHash = deployment.deployedCodeHashes?.policyAnchor;
  const expectedAuthorityRuntimeHash =
    deployment.deployedCodeHashes?.thresholdAuthority;
  if (
    !HASH_PATTERN.test(expectedRuntimeHash ?? "") ||
    !HASH_PATTERN.test(expectedAuthorityRuntimeHash ?? "")
  ) {
    throw new Error("V44_POLICY_ACTIVATION_RUNTIME_HASH_MISSING");
  }
  const publications = [];
  for (const anchor of activation.anchorHistory ?? []) {
    if (
      !HASH_PATTERN.test(anchor?.publication?.transactionHash ?? "") ||
      !Number.isSafeInteger(anchor?.publication?.logIndex) ||
      anchor.publication.logIndex < 0
    ) {
      throw new Error("V44_POLICY_ACTIVATION_PUBLICATION_LOCATOR_INVALID");
    }
    const transactionHash = anchor.publication.transactionHash;
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: transactionHash }),
      client.getTransaction({ hash: transactionHash }),
    ]);
    if (
      receipt.status !== "success" ||
      transaction.to?.toLowerCase() !== authorityAddress.toLowerCase() ||
      receipt.blockNumber > finalizedHead.number
    ) {
      throw new Error("V44_POLICY_ACTIVATION_PUBLICATION_INVALID");
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const [
      runtimeCode,
      authorityRuntimeCode,
      anchoredAuthority,
      authorityOwners,
      authorityThreshold,
    ] = await Promise.all([
      client.getCode({
        address: policyAnchorAddress,
        blockNumber: receipt.blockNumber,
      }),
      client.getCode({
        address: authorityAddress,
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: policyAnchorAddress,
        abi: artifact(CONTRACT_TYPES.policyAnchor).abi,
        functionName: "ACTIVATION_AUTHORITY",
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: authorityAddress,
        abi: THRESHOLD_AUTHORITY_ABI,
        functionName: "getOwners",
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: authorityAddress,
        abi: THRESHOLD_AUTHORITY_ABI,
        functionName: "getThreshold",
        blockNumber: receipt.blockNumber,
      }),
    ]);
    const authorityRuntimeCodeHash = keccak256(authorityRuntimeCode);
    let authorityCall;
    try {
      authorityCall = decodeFunctionData({
        abi: artifact(CONTRACT_TYPES.thresholdAuthority).abi,
        data: transaction.input,
      });
    } catch {
      throw new Error("V44_POLICY_ACTIVATION_AUTHORITY_CALL_INVALID");
    }
    const normalizedOwners = [...authorityOwners]
      .map((owner) => getAddress(owner).toLowerCase())
      .sort();
    if (
      block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase() ||
      !runtimeCode ||
      keccak256(runtimeCode) !== expectedRuntimeHash.toLowerCase() ||
      !authorityRuntimeCode ||
      authorityRuntimeCodeHash !== expectedAuthorityRuntimeHash.toLowerCase() ||
      authorityRuntimeCodeHash !==
        activation.thresholdAuthority.runtimeCodeHash.toLowerCase() ||
      anchoredAuthority.toLowerCase() !== authorityAddress.toLowerCase() ||
      authorityCall.functionName !== "executePolicyActivation" ||
      authorityCall.args[0].toLowerCase() !== policyAnchorAddress.toLowerCase() ||
      Number(authorityCall.args[1]) !== anchor.activationSequence ||
      authorityCall.args[2].toLowerCase() !==
        asBytes32(anchor.policyConfigurationHash, "POLICY_HASH") ||
      authorityCall.args[3].toLowerCase() !==
        asBytes32(anchor.signerSetHash, "SIGNER_SET_HASH") ||
      authorityCall.args[4].toLowerCase() !==
        asBytes32(anchor.activationSignerSetHash, "ACTIVATION_SIGNER_HASH") ||
      Number(authorityCall.args[5]) !== anchor.activationThreshold ||
      authorityCall.args[6].toLowerCase() !==
        asBytes32(anchor.activationBindingsRoot, "BINDINGS_ROOT") ||
      authorityCall.args[7].toLowerCase() !==
        `0x${anchor.evidencePipelineCommit}` ||
      authorityCall.args[8].toLowerCase() !== anchor.previousAnchorHash ||
      authorityCall.args[9].toLowerCase() !== anchor.transparencyLogRoot ||
      authorityCall.args[12].length < activation.thresholdAuthority.threshold ||
      Number(authorityThreshold) !==
        activation.thresholdAuthority.threshold ||
      sha256Json(normalizedOwners) !==
        sha256Json(
          activation.thresholdAuthority.owners
            .map((owner) => owner.toLowerCase())
            .sort(),
        )
    ) {
      throw new Error("V44_POLICY_ACTIVATION_RUNTIME_INVALID");
    }
    const log = receipt.logs.find(
      (candidate) =>
        candidate.address?.toLowerCase() === policyAnchorAddress.toLowerCase() &&
        Number(candidate.logIndex) === anchor.publication.logIndex,
    );
    if (!log) {
      throw new Error("V44_POLICY_ACTIVATION_EVENT_MISSING");
    }
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [POLICY_ACTIVATION_ANCHORED_EVENT],
        eventName: "PolicyActivationAnchored",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      throw new Error("V44_POLICY_ACTIVATION_EVENT_INVALID");
    }
    const publication = canonicalActivationPublication({
      ...decoded.args,
      transactionHash,
      logIndex: anchor.publication.logIndex,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestampMs: Number(block.timestamp) * 1_000,
      authorityRuntimeCodeHash,
      authorityOwners: normalizedOwners,
      authorityThreshold: Number(authorityThreshold),
    });
    const expected = canonicalActivationPublication({
      anchorHash: anchor.anchorHash,
      activationSequence: anchor.activationSequence,
      policyConfigurationHash: asBytes32(
        anchor.policyConfigurationHash,
        "POLICY_HASH",
      ),
      activationAuthority: authorityAddress,
      signerSetHash: asBytes32(anchor.signerSetHash, "SIGNER_SET_HASH"),
      activationSignerSetHash: asBytes32(
        anchor.activationSignerSetHash,
        "ACTIVATION_SIGNER_HASH",
      ),
      activationThreshold: anchor.activationThreshold,
      activationBindingsRoot: asBytes32(
        anchor.activationBindingsRoot,
        "BINDINGS_ROOT",
      ),
      evidencePipelineCommit: `0x${anchor.evidencePipelineCommit}`,
      previousAnchorHash: anchor.previousAnchorHash,
      transparencyLogRoot: anchor.transparencyLogRoot,
      transactionHash,
      logIndex: anchor.publication.logIndex,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestampMs: Number(block.timestamp) * 1_000,
      authorityRuntimeCodeHash,
      authorityOwners: normalizedOwners,
      authorityThreshold: Number(authorityThreshold),
    });
    if (sha256Json(publication) !== sha256Json(expected)) {
      throw new Error("V44_POLICY_ACTIVATION_EVENT_MISMATCH");
    }
    publications.push(publication);
  }
  return {
    identity: providerOperatorId,
    providerOperatorId,
    origin,
    providerFinalizedHeadNumber: Number(finalizedHead.number),
    providerFinalizedHeadHash: finalizedHead.hash.toLowerCase(),
    runtimeCodeHash: expectedRuntimeHash,
    publications,
  };
}

export function reconcilePolicyActivationPublicationSnapshots({
  providers,
  providerOperatorPolicy,
}) {
  if (!Array.isArray(providers) || providers.length < 2) {
    throw new Error("V44_POLICY_ACTIVATION_TWO_PROVIDERS_REQUIRED");
  }
  const pinned = new Map(
    (providerOperatorPolicy?.providers ?? []).map((provider) => [
      provider.operatorId,
      provider,
    ]),
  );
  if (
    providerOperatorPolicy?.configurationStatus !== "ACTIVE" ||
    new Set(providers.map((provider) => provider.providerOperatorId)).size < 2 ||
    new Set(
      providers.map(
        (provider) =>
          pinned.get(provider.providerOperatorId)?.custodyDomainId,
      ),
    ).size < 2 ||
    providers.some((provider) => {
      const policy = pinned.get(provider.providerOperatorId);
      return (
        !policy ||
        !policy.allowedOrigins.includes(provider.origin) ||
        provider.identity !== provider.providerOperatorId
      );
    })
  ) {
    throw new Error("V44_POLICY_ACTIVATION_PROVIDER_INDEPENDENCE_INVALID");
  }
  const publicationRoot = sha256Json(providers[0].publications);
  if (
    providers.some(
      (provider) => sha256Json(provider.publications) !== publicationRoot,
    )
  ) {
    throw new Error("V44_POLICY_ACTIVATION_PROVIDER_CONFLICT");
  }
  return {
    publications: providers[0].publications,
    publicationRoot,
    providerCount: providers.length,
  };
}

function canonicalMaturityPublication(value) {
  return {
    publicationHash: value.publicationHash.toLowerCase(),
    authorizationId: value.authorizationId.toLowerCase(),
    exposureSlotId: value.exposureSlotId.toLowerCase(),
    precommitCheckpointHash: value.precommitCheckpointHash.toLowerCase(),
    admissionBundleHash: value.admissionBundleHash.toLowerCase(),
    evidencePipelineCommit: value.evidencePipelineCommit.toLowerCase(),
    deploymentManifestHash: value.deploymentManifestHash.toLowerCase(),
    transactionHash: value.transactionHash.toLowerCase(),
    logIndex: Number(value.logIndex),
    blockNumber: Number(value.blockNumber),
    blockHash: value.blockHash.toLowerCase(),
    blockTimestampMs: Number(value.blockTimestampMs),
  };
}

export async function collectMaturityAuthorizationPublicationSnapshot({
  rpcUrl,
  deployment,
  authorization,
  providerOperatorId,
  client: suppliedClient = null,
}) {
  if (
    !isAddress(deployment?.contracts?.thresholdAuthority ?? "") ||
    !isAddress(deployment?.contracts?.maturityAnchor ?? "") ||
    !HASH_PATTERN.test(authorization?.publication?.transactionHash ?? "") ||
    !Number.isSafeInteger(authorization?.publication?.logIndex) ||
    authorization.publication.logIndex < 0
  ) {
    throw new Error("V44_MATURITY_PUBLICATION_LOCATOR_INVALID");
  }
  const client = suppliedClient ?? createPublicClient({ transport: http(rpcUrl) });
  const authorityAddress = getAddress(deployment.contracts.thresholdAuthority);
  const maturityAnchorAddress = getAddress(deployment.contracts.maturityAnchor);
  const transactionHash = authorization.publication.transactionHash;
  const [receipt, transaction, finalizedHead] = await Promise.all([
    client.getTransactionReceipt({ hash: transactionHash }),
    client.getTransaction({ hash: transactionHash }),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  if (
    receipt.status !== "success" ||
    transaction.to?.toLowerCase() !== authorityAddress.toLowerCase() ||
    receipt.blockNumber > finalizedHead.number
  ) {
    throw new Error("V44_MATURITY_PUBLICATION_INVALID");
  }
  const [
    block,
    authorityCode,
    maturityAnchorCode,
    maturityAuthority,
    authorityOwners,
    threshold,
  ] =
    await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getCode({ address: authorityAddress, blockNumber: receipt.blockNumber }),
      client.getCode({
        address: maturityAnchorAddress,
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: maturityAnchorAddress,
        abi: artifact(CONTRACT_TYPES.maturityAnchor).abi,
        functionName: "AUTHORITY",
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: authorityAddress,
        abi: artifact(CONTRACT_TYPES.thresholdAuthority).abi,
        functionName: "getOwners",
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: authorityAddress,
        abi: artifact(CONTRACT_TYPES.thresholdAuthority).abi,
        functionName: "getThreshold",
        blockNumber: receipt.blockNumber,
      }),
    ]);
  let call;
  try {
    call = decodeFunctionData({
      abi: artifact(CONTRACT_TYPES.thresholdAuthority).abi,
      data: transaction.input,
    });
  } catch {
    throw new Error("V44_MATURITY_AUTHORITY_CALL_INVALID");
  }
  if (
    !authorityCode ||
    keccak256(authorityCode) !==
      deployment.deployedCodeHashes.thresholdAuthority.toLowerCase() ||
    !maturityAnchorCode ||
    keccak256(maturityAnchorCode) !==
      deployment.deployedCodeHashes.maturityAnchor.toLowerCase() ||
    maturityAuthority.toLowerCase() !== authorityAddress.toLowerCase() ||
    sha256Json(authorityOwners.map((owner) => owner.toLowerCase())) !==
      sha256Json(deployment.thresholdAuthorityOwners.map((owner) => owner.toLowerCase())) ||
    Number(threshold) !== deployment.thresholdAuthorityThreshold ||
    call.functionName !== "executeMaturityPublication" ||
    call.args[0].toLowerCase() !== maturityAnchorAddress.toLowerCase() ||
    call.args[1].toLowerCase() !== `0x${authorization.authorizationId}` ||
    call.args[2].toLowerCase() !== authorization.precommitCheckpointHash ||
    call.args[3].toLowerCase() !== authorization.authorizedExposureSlotId ||
    call.args[4].toLowerCase() !== authorization.admissionBundleHash ||
    call.args[5].toLowerCase() !== `0x${authorization.sourceCommit}` ||
    call.args[6].toLowerCase() !== `0x${authorization.deploymentManifestSha256}` ||
    call.args[9].length < Number(threshold)
  ) {
    throw new Error("V44_MATURITY_AUTHORITY_EXECUTION_INVALID");
  }
  const log = receipt.logs.find(
    (candidate) =>
      candidate.address?.toLowerCase() === maturityAnchorAddress.toLowerCase() &&
      Number(candidate.logIndex) === authorization.publication.logIndex,
  );
  if (!log) throw new Error("V44_MATURITY_PUBLICATION_EVENT_MISSING");
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: artifact(CONTRACT_TYPES.maturityAnchor).abi,
      eventName: "MaturityAuthorizationPublished",
      data: log.data,
      topics: log.topics,
      strict: true,
    });
  } catch {
    throw new Error("V44_MATURITY_PUBLICATION_EVENT_INVALID");
  }
  const publication = canonicalMaturityPublication({
    ...decoded.args,
    transactionHash,
    logIndex: authorization.publication.logIndex,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestampMs: Number(block.timestamp) * 1_000,
  });
  if (
    publication.authorizationId !== `0x${authorization.authorizationId}` ||
    publication.exposureSlotId !== authorization.authorizedExposureSlotId ||
    publication.precommitCheckpointHash !== authorization.precommitCheckpointHash ||
    publication.admissionBundleHash !== authorization.admissionBundleHash ||
    publication.evidencePipelineCommit !== `0x${authorization.sourceCommit}` ||
    publication.deploymentManifestHash !==
      `0x${authorization.deploymentManifestSha256}`
  ) {
    throw new Error("V44_MATURITY_PUBLICATION_EVENT_MISMATCH");
  }
  return {
    identity: providerOperatorId,
    providerOperatorId,
    origin: new URL(rpcUrl).origin,
    providerFinalizedHeadNumber: Number(finalizedHead.number),
    providerFinalizedHeadHash: finalizedHead.hash.toLowerCase(),
    publication,
  };
}

export function reconcileMaturityAuthorizationPublicationSnapshots({
  providers,
  providerOperatorPolicy,
}) {
  if (!Array.isArray(providers) || providers.length < 2) {
    throw new Error("V44_MATURITY_PUBLICATION_TWO_PROVIDERS_REQUIRED");
  }
  const pinned = new Map(
    (providerOperatorPolicy?.providers ?? []).map((provider) => [
      provider.operatorId,
      provider,
    ]),
  );
  if (
    providerOperatorPolicy?.configurationStatus !== "ACTIVE" ||
    new Set(providers.map((provider) => provider.providerOperatorId)).size < 2 ||
    new Set(
      providers.map(
        (provider) => pinned.get(provider.providerOperatorId)?.custodyDomainId,
      ),
    ).size < 2 ||
    providers.some((provider) =>
      !pinned
        .get(provider.providerOperatorId)
        ?.allowedOrigins?.includes(provider.origin),
    ) ||
    providers.some(
      (provider) =>
        sha256Json(provider.publication) !==
        sha256Json(providers[0].publication),
    )
  ) {
    throw new Error("V44_MATURITY_PUBLICATION_PROVIDER_CONFLICT");
  }
  return { eligible: true, publication: providers[0].publication };
}

export function loadReliabilityPolicy(
  filePath = path.join(
    ROOT,
    "mainnet-v44-testnet-reliability-policy.json",
  ),
) {
  const policy = readJson(filePath);
  if (
    policy.schema !== POLICY_SCHEMA ||
    policy.release !== VERSION ||
    policy.observedChainId !== TESTNET_CHAIN_ID ||
    policy.targetChainId !== TARGET_CHAIN_ID
  ) {
    throw new Error("V44_TESTNET_POLICY_IDENTITY_INVALID");
  }
  validateAutonomyPolicy(policy.autonomyV2);
  const { config } = loadAndValidateConfig();
  const requiredRecoveryLifetimeSeconds =
    policy.minimumObservationDays * 86_400 +
    policy.autonomyV2.maturityAuthorizationPolicy
      .minimumRecoveryAvailabilitySeconds;
  if (
    config.dynamicIssues.maxLifetimeSeconds < requiredRecoveryLifetimeSeconds
  ) {
    throw new Error("V44_TESTNET_RECOVERY_LIFETIME_TOO_SHORT");
  }
  for (const check of policy.autonomyV2.maturityAuthorizationPolicy
    .readinessEvidencePolicy.governanceDryRun.checkPolicy) {
    const callAbi = artifact(CONTRACT_TYPES[check.contractKey]).abi;
    const matchingFunctions = callAbi.filter(
      (entry) =>
        entry.type === "function" && entry.name === check.functionName,
    );
    if (
      matchingFunctions.length !== 1
    ) {
      throw new Error(`V44_TESTNET_DRY_RUN_FUNCTION_INVALID:${check.id}`);
    }
    for (const requiredEvent of check.requiredEvents) {
      const eventAbi = artifact(
        CONTRACT_TYPES[requiredEvent.contractKey],
      ).abi;
      if (
        !eventAbi.some(
          (entry) =>
            entry.type === "event" &&
            toEventSignature(entry) === requiredEvent.signature,
        )
      ) {
        throw new Error(`V44_TESTNET_DRY_RUN_EVENT_INVALID:${check.id}`);
      }
    }
  }
  for (const [label, value, minimum] of [
    ["minimumObservationDays", policy.minimumObservationDays, 90],
    ["maximumEvidenceAgeHours", policy.maximumEvidenceAgeHours, 1],
    ["maximumIndexerLagBlocks", policy.maximumIndexerLagBlocks, 0],
    ["minimumVerifiedTransactions", policy.minimumVerifiedTransactions, 1],
    ["minimumContributingAgents", policy.minimumContributingAgents, 5],
    [
      "minimumContributingOperatorGroups",
      policy.minimumContributingOperatorGroups,
      3,
    ],
    ["minimumIndependentObservers", policy.minimumIndependentObservers, 2],
    [
      "minimumIndependentObserverGroups",
      policy.minimumIndependentObserverGroups,
      2,
    ],
    [
      "maximumOpenCriticalIncidents",
      policy.maximumOpenCriticalIncidents,
      0,
    ],
  ]) {
    requireInteger(value, minimum, label);
  }
  const observerPolicy = policy.autonomyV2.observerIndependencePolicy;
  const observerBindings = observerPolicy?.bindings ?? [];
  if (
    ![
      "PENDING_EXTERNAL_CONTROLLERS",
      "ACTIVE",
    ].includes(observerPolicy?.configurationStatus) ||
    !Array.isArray(observerBindings) ||
    (observerPolicy.configurationStatus === "PENDING_EXTERNAL_CONTROLLERS" &&
      observerBindings.length !== 0) ||
    (observerPolicy.configurationStatus === "ACTIVE" &&
      (observerBindings.length < policy.minimumIndependentObservers ||
        new Set(
          observerBindings.map((binding) => binding.observer?.toLowerCase?.()),
        ).size !== observerBindings.length ||
        new Set(
          observerBindings.map((binding) => binding.controllerDomainId),
        ).size < policy.minimumIndependentObservers ||
        new Set(
          observerBindings.map((binding) => binding.custodyDomainId),
        ).size < policy.minimumIndependentObservers ||
        observerBindings.some(
          (binding) =>
            !isAddress(binding.observer ?? "") ||
            !HASH_PATTERN.test(binding.operatorGroup ?? "") ||
            typeof binding.controllerDomainId !== "string" ||
            binding.controllerDomainId.length < 3 ||
            typeof binding.custodyDomainId !== "string" ||
            binding.custodyDomainId.length < 3 ||
            !HASH_PATTERN.test(binding.corroborationEvidenceHash ?? ""),
        )))
  ) {
    throw new Error("V44_TESTNET_OBSERVER_INDEPENDENCE_POLICY_INVALID");
  }
  const categoryEntries = Object.entries(policy.categories ?? {});
  if (categoryEntries.length === 0) {
    throw new Error("V44_TESTNET_POLICY_CATEGORIES_EMPTY");
  }
  let requiredTransactions = 0;
  for (const [category, rule] of categoryEntries) {
    requireInteger(rule?.minimum, 1, `categories.${category}.minimum`);
    requiredTransactions += rule.minimum;
    if (
      !["success", "reverted"].includes(rule.transactionStatus) ||
      !(rule.contractKey in CONTRACT_TYPES) ||
      !Array.isArray(rule.requiredEvents) ||
      typeof rule.functionName !== "string" ||
      !SEMANTICS.has(rule.semantic)
    ) {
      throw new Error(`V44_TESTNET_POLICY_CATEGORY_INVALID:${category}`);
    }
    const contractAbi = artifact(CONTRACT_TYPES[rule.contractKey]).abi;
    const errorContractKey = rule.errorContractKey ?? rule.contractKey;
    if (!(errorContractKey in CONTRACT_TYPES)) {
      throw new Error(`V44_TESTNET_POLICY_ERROR_CONTRACT_INVALID:${category}`);
    }
    const errorContractAbi = artifact(
      CONTRACT_TYPES[errorContractKey],
    ).abi;
    if (
      !contractAbi.some(
        (entry) =>
          entry.type === "function" &&
          entry.name === rule.functionName,
      ) ||
      (
        rule.transactionStatus === "reverted" &&
        (
          typeof rule.expectedRevertError !== "string" ||
          !errorContractAbi.some(
            (entry) =>
              entry.type === "error" &&
              entry.name === rule.expectedRevertError,
          )
        )
      )
    ) {
      throw new Error(`V44_TESTNET_POLICY_FUNCTION_INVALID:${category}`);
    }
    for (const event of rule.requiredEvents) {
      if (
        !(event?.contractKey in CONTRACT_TYPES) ||
        typeof event.signature !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/u.test(event.signature)
      ) {
        throw new Error(`V44_TESTNET_POLICY_EVENT_INVALID:${category}`);
      }
    }
  }
  if (policy.minimumVerifiedTransactions < requiredTransactions) {
    throw new Error("V44_TESTNET_POLICY_TRANSACTION_FLOOR_TOO_LOW");
  }
  if (
    !Array.isArray(policy.criticalInvariants) ||
    policy.criticalInvariants.length < 7 ||
    new Set(policy.criticalInvariants).size !== policy.criticalInvariants.length
  ) {
    throw new Error("V44_TESTNET_POLICY_INVARIANTS_INVALID");
  }
  return {
    policy,
    policyPath: path.resolve(filePath),
    policySha256: sha256File(filePath),
  };
}

export function validateTestnetDeployment(deployment, sourceEvidence) {
  if (
    deployment?.schema !== DEPLOYMENT_SCHEMA ||
    deployment.chainId !== TESTNET_CHAIN_ID ||
    deployment.network !== "Base Sepolia" ||
    deployment.release !== VERSION
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_IDENTITY_INVALID");
  }
  if (
    !/^[0-9a-f]{40}$/u.test(deployment.sourceCommit ?? "") ||
    deployment.sourceCommit !== sourceEvidence?.sourceCommit ||
    !SHA256_PATTERN.test(deployment.sourceEvidenceSha256 ?? "") ||
    deployment.sourceEvidenceSha256 !== sourceEvidence?.evidenceSha256 ||
    deployment.financeInvariantHash !== sourceEvidence?.financeInvariantHash ||
    deployment.configSha256 !== sourceEvidence?.configSha256
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_SOURCE_INVALID");
  }
  const currentContractKeys = Object.keys(CONTRACT_TYPES);
  const legacyContractKeys = currentContractKeys.filter(
    (key) =>
      !["thresholdAuthority", "policyAnchor", "maturityAnchor"].includes(key),
  );
  const contractKeys = Object.hasOwn(deployment.contracts ?? {}, "policyAnchor")
    ? currentContractKeys
    : legacyContractKeys;
  exactKeys(deployment.contracts, contractKeys, "DEPLOYMENT_CONTRACT");
  exactKeys(
    deployment.deployedCodeHashes,
    contractKeys,
    "DEPLOYMENT_CODE_HASH",
  );
  exactKeys(
    deployment.deploymentTransactions,
    contractKeys,
    "DEPLOYMENT_TRANSACTION",
  );
  exactKeys(
    deployment.creationInputHashes,
    contractKeys,
    "DEPLOYMENT_INPUT_HASH",
  );
  exactKeys(
    deployment.artifactTypes,
    contractKeys,
    "DEPLOYMENT_ARTIFACT_TYPE",
  );
  const artifactTypes = [
    ...new Set(contractKeys.map((key) => CONTRACT_TYPES[key])),
  ];
  exactKeys(
    deployment.artifactCreationBytecodeHashes,
    artifactTypes,
    "DEPLOYMENT_ARTIFACT_HASH",
  );
  if (!isAddress(deployment.deployer)) {
    throw new Error("V44_TESTNET_DEPLOYMENT_DEPLOYER_INVALID");
  }
  if (
    Object.hasOwn(deployment.contracts ?? {}, "policyAnchor") &&
    (!isAddress(deployment.policyActivationAuthority ?? "") ||
      deployment.policyActivationAuthority.toLowerCase() !==
        deployment.contracts.thresholdAuthority?.toLowerCase?.() ||
      !Array.isArray(deployment.thresholdAuthorityOwners) ||
      deployment.thresholdAuthorityOwners.length < 2 ||
      new Set(
        deployment.thresholdAuthorityOwners.map((owner) =>
          owner?.toLowerCase?.(),
        ),
      ).size !== deployment.thresholdAuthorityOwners.length ||
      deployment.thresholdAuthorityOwners.some((owner) => !isAddress(owner)) ||
      !Number.isSafeInteger(deployment.thresholdAuthorityThreshold) ||
      deployment.thresholdAuthorityThreshold < 2 ||
      deployment.thresholdAuthorityThreshold >
        deployment.thresholdAuthorityOwners.length)
  ) {
    throw new Error("V44_TESTNET_POLICY_ACTIVATION_AUTHORITY_INVALID");
  }
  const seenAddresses = new Set();
  for (const key of contractKeys) {
    const address = deployment.contracts[key];
    const codeHash = deployment.deployedCodeHashes[key];
    const transactionHash = deployment.deploymentTransactions[key];
    const creationInputHash = deployment.creationInputHashes[key];
    const artifactType = deployment.artifactTypes[key];
    if (
      !isAddress(address) ||
      !HASH_PATTERN.test(codeHash ?? "") ||
      !HASH_PATTERN.test(transactionHash ?? "") ||
      !HASH_PATTERN.test(creationInputHash ?? "") ||
      artifactType !== CONTRACT_TYPES[key]
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_CONTRACT_INVALID:${key}`);
    }
    const normalizedAddress = getAddress(address).toLowerCase();
    if (seenAddresses.has(normalizedAddress)) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_ADDRESS_REUSED:${key}`);
    }
    seenAddresses.add(normalizedAddress);
  }
  for (const type of artifactTypes) {
    const declared = deployment.artifactCreationBytecodeHashes[type];
    const sourceHash = sourceEvidence?.artifacts?.[type]?.creationBytecodeHash;
    if (
      !HASH_PATTERN.test(declared ?? "") ||
      declared.toLowerCase() !== sourceHash?.toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_ARTIFACT_INVALID:${type}`);
    }
  }
  requireInteger(deployment.deploymentBlock, 1, "deploymentBlock");
  requireInteger(deployment.genesisStart, 1, "genesisStart");
  for (const [label, value] of [
    ["GENESIS_RELEASE", deployment.genesisRelease],
    ["GENESIS_MODULE_HASH", deployment.genesisModuleHash],
    ["GENESIS_MANIFEST_HASH", deployment.genesisManifestHash],
    ["BOOTSTRAP_ROOT", deployment.bootstrapRoot],
    ["DYNAMIC_VALIDATOR_ROOT", deployment.dynamicValidatorRoot],
    ["BOOTSTRAP_VERIFIER_CODEHASH", deployment.bootstrapVerifierCodehash],
  ]) {
    if (!HASH_PATTERN.test(value ?? "") || /^0x0{64}$/u.test(value)) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_${label}_INVALID`);
    }
  }
  const validators = deployment.bootstrap?.validators;
  if (!Array.isArray(validators) || validators.length < 3) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INVALID");
  }
  const observerAddresses = new Set();
  const observerGroups = new Set();
  const leaves = validators.map((entry) => {
    if (
      !isAddress(entry?.address) ||
      !HASH_PATTERN.test(entry?.group ?? "") ||
      entry.group.toLowerCase() === ZERO_BYTES32
    ) {
      throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INVALID");
    }
    const address = getAddress(entry.address).toLowerCase();
    const group = entry.group.toLowerCase();
    if (
      observerAddresses.has(address) ||
      observerGroups.has(group)
    ) {
      throw new Error("V44_TESTNET_OBSERVER_REGISTRY_NOT_INDEPENDENT");
    }
    observerAddresses.add(address);
    observerGroups.add(group);
    return validatorLeaf(address, group);
  });
  if (
    merkleCatalog(leaves).root.toLowerCase() !==
    deployment.dynamicValidatorRoot.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_ROOT_MISMATCH");
  }
  const unsigned = structuredClone(deployment);
  delete unsigned.manifestSha256;
  if (
    !SHA256_PATTERN.test(deployment.manifestSha256 ?? "") ||
    sha256Json(unsigned) !== deployment.manifestSha256
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_SELF_HASH_INVALID");
  }
  return deployment;
}

function historicalSolidityBlobs(sourceCommit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    throw new Error("V44_HISTORICAL_CONTRACT_COMMIT_MISSING");
  }
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", sourceCommit, "--", "contracts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(
        /^(?<mode>[0-9]+) blob (?<blob>[0-9a-f]{40})\t(?<file>.+)$/u,
      );
      if (!match?.groups || !match.groups.file.endsWith(".sol")) return null;
      return {
        file: match.groups.file.replaceAll("\\", "/"),
        gitBlob: match.groups.blob,
        mode: match.groups.mode,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function verifyHistoricalContractSourceEvidenceFile(
  filePath,
  deployment,
) {
  const resolvedPath = path.resolve(filePath);
  const evidence = readJson(resolvedPath);
  const body = structuredClone(evidence);
  delete body.evidenceSha256;
  const expectedTree = execFileSync(
    "git",
    ["rev-parse", `${deployment.sourceCommit}^{tree}`],
    { cwd: ROOT, encoding: "utf8" },
  ).trim().toLowerCase();
  if (
    evidence?.schema !==
      "agentpool.mainnet.v44.source-reproducibility/v1" ||
    evidence.release !== VERSION ||
    evidence.chainId !== TARGET_CHAIN_ID ||
    evidence.sourceCommit !== deployment.sourceCommit ||
    evidence.sourceTree !== expectedTree ||
    evidence.evidenceSha256 !== sha256Json(body) ||
    deployment.sourceEvidenceSha256 !== evidence.evidenceSha256 ||
    deployment.configSha256 !== evidence.configSha256 ||
    deployment.financeInvariantHash !== evidence.financeInvariantHash ||
    JSON.stringify(evidence.soliditySources) !==
      JSON.stringify(historicalSolidityBlobs(deployment.sourceCommit))
  ) {
    throw new Error("V44_HISTORICAL_CONTRACT_SOURCE_INVALID");
  }
  for (const [contractKey, artifactType] of Object.entries(
    deployment.artifactTypes ?? {},
  )) {
    if (
      evidence.artifacts?.[artifactType]?.creationBytecodeHash !==
      deployment.artifactCreationBytecodeHashes?.[artifactType] ||
      !deployment.contracts?.[contractKey]
    ) {
      throw new Error("V44_HISTORICAL_CONTRACT_ARTIFACT_INVALID");
    }
  }
  return {
    evidence,
    filePath: resolvedPath,
    fileSha256: sha256File(resolvedPath),
  };
}

export function validateObservations(
  observations,
  {
    policy,
    policySha256,
    deployment,
    evidencePipelineCommit,
    trustedActivationPublications = null,
  },
) {
  const policyIdentity = autonomyPolicyIdentity(
    policy?.autonomyV2,
    evidencePipelineCommit,
    {
      policyAnchorAddress: deployment.contracts.policyAnchor,
      trustedPublications: trustedActivationPublications,
    },
  );
  if (
    observations?.schema !== OBSERVATION_SCHEMA ||
    observations.observedChainId !== TESTNET_CHAIN_ID ||
    observations.release !== VERSION ||
    observations.contractSourceCommit !== deployment.sourceCommit ||
    observations.evidencePipelineCommit !== evidencePipelineCommit ||
    observations.deploymentManifestSha256 !== deployment.manifestSha256 ||
    observations.policySha256 !== policySha256 ||
    observations.signerSetHash !== policyIdentity.signerSetHash ||
    observations.policyActivatedAt !== policyIdentity.activatedAt ||
    observations.policyActivatedBlock !== policyIdentity.activatedBlock ||
    (observations.policyActivationSequence ?? null) !==
      policyIdentity.activationSequence ||
    (observations.policyActivationAnchorHash ?? null) !==
      policyIdentity.activationAnchorHash
  ) {
    throw new Error("V44_TESTNET_OBSERVATIONS_IDENTITY_INVALID");
  }
  const startedAt = requireIso(
    observations.startedAt,
    "OBSERVATION_START",
  );
  const endedAt = requireIso(observations.endedAt, "OBSERVATION_END");
  if (endedAt <= startedAt) {
    throw new Error("V44_TESTNET_OBSERVATION_WINDOW_INVALID");
  }
  if (
    !Array.isArray(observations.observations) ||
    !Array.isArray(observations.incidents) ||
    !Array.isArray(observations.attestations)
  ) {
    throw new Error("V44_TESTNET_OBSERVATIONS_SHAPE_INVALID");
  }
  const seenTransactions = new Set();
  for (const entry of observations.observations) {
    const rule = policy.categories?.[entry?.category];
    if (
      !rule ||
      !HASH_PATTERN.test(entry.txHash ?? "") ||
      entry.contractKey !== rule.contractKey ||
      entry.expectedStatus !== rule.transactionStatus ||
      !Number.isSafeInteger(entry.blockNumber) ||
      entry.blockNumber < deployment.deploymentBlock ||
      (
        policyIdentity.activatedBlock !== null &&
        entry.blockNumber < policyIdentity.activatedBlock
      )
    ) {
      throw new Error("V44_TESTNET_OBSERVATION_ENTRY_INVALID");
    }
    const normalizedHash = entry.txHash.toLowerCase();
    if (seenTransactions.has(normalizedHash)) {
      throw new Error("V44_TESTNET_OBSERVATION_TX_REUSED");
    }
    seenTransactions.add(normalizedHash);
  }
  return { observations, startedAt, endedAt };
}

export async function verifyObservationAttestations(
  observations,
  policy,
  deployment,
) {
  const message = observationAttestationMessage(observations);
  const addresses = new Set();
  const groups = new Set();
  const controllerDomains = new Set();
  const custodyDomains = new Set();
  const independencePolicy = policy.autonomyV2.observerIndependencePolicy;
  const controlBindings = new Map(
    (independencePolicy?.bindings ?? []).map((binding) => [
      getAddress(binding.observer).toLowerCase(),
      binding,
    ]),
  );
  if (independencePolicy?.configurationStatus !== "ACTIVE") {
    throw new Error("V44_TESTNET_OBSERVER_INDEPENDENCE_POLICY_NOT_READY");
  }
  const observerRegistry = new Map(
    (deployment?.bootstrap?.validators ?? []).map((entry) => [
      getAddress(entry.address).toLowerCase(),
      entry.group.toLowerCase(),
    ]),
  );
  if (observerRegistry.size < policy.minimumIndependentObservers) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INSUFFICIENT");
  }
  for (const attestation of observations.attestations) {
    if (
      !isAddress(attestation?.observer) ||
      !HASH_PATTERN.test(attestation?.operatorGroup ?? "") ||
      typeof attestation.signature !== "string"
    ) {
      throw new Error("V44_TESTNET_OBSERVER_ATTESTATION_INVALID");
    }
    const recovered = await recoverMessageAddress({
      message,
      signature: attestation.signature,
    });
    if (
      recovered.toLowerCase() !==
      getAddress(attestation.observer).toLowerCase()
    ) {
      throw new Error("V44_TESTNET_OBSERVER_SIGNATURE_INVALID");
    }
    const recoveredAddress = recovered.toLowerCase();
    const registeredGroup = observerRegistry.get(recoveredAddress);
    const controlBinding = controlBindings.get(recoveredAddress);
    if (
      !registeredGroup ||
      registeredGroup !== attestation.operatorGroup.toLowerCase() ||
      controlBinding?.operatorGroup?.toLowerCase?.() !== registeredGroup ||
      typeof controlBinding.controllerDomainId !== "string" ||
      typeof controlBinding.custodyDomainId !== "string" ||
      !HASH_PATTERN.test(controlBinding.corroborationEvidenceHash ?? "")
    ) {
      throw new Error("V44_TESTNET_OBSERVER_NOT_REGISTERED");
    }
    addresses.add(recoveredAddress);
    groups.add(registeredGroup);
    controllerDomains.add(controlBinding.controllerDomainId);
    custodyDomains.add(controlBinding.custodyDomainId);
  }
  return {
    verified: true,
    observerCount: addresses.size,
    observerGroupCount: groups.size,
    observerControllerDomainCount: controllerDomains.size,
    observerCustodyDomainCount: custodyDomains.size,
    meetsIndependence:
      addresses.size >= policy.minimumIndependentObservers &&
      groups.size >= policy.minimumIndependentObserverGroups &&
      controllerDomains.size >= policy.minimumIndependentObservers &&
      custodyDomains.size >= policy.minimumIndependentObservers,
  };
}

function eventTopic(signature) {
  return keccak256(toBytes(signature)).toLowerCase();
}

function indexedAddress(topic) {
  if (!HASH_PATTERN.test(topic ?? "")) return null;
  return getAddress(`0x${topic.slice(-40)}`);
}

export function canonicalDeploymentArguments({
  deployment,
  config,
}) {
  const proposalBond = parseEther(config.consensus.proposalBondApool);
  const argumentsByKey = {
    token: [deployment.deployer],
    settlementRouter: [deployment.deployer],
    releaseRegistry: [
      deployment.genesisRelease,
      deployment.genesisModuleHash,
      deployment.genesisManifestHash,
      deployment.deployer,
    ],
    capacityRegistry: [deployment.deployer],
    userEscrow: [
      deployment.contracts.token,
      deployment.deployer,
    ],
    coreEpochVault: [
      deployment.contracts.token,
      keccak256(toBytes("CORE")),
      BigInt(deployment.genesisStart),
      parseEther(config.emission.coreWeeklyCapApool),
      parseEther(config.emission.coreLifetimeCapApool),
      deployment.deployer,
    ],
    evolutionEpochVault: [
      deployment.contracts.token,
      keccak256(toBytes("EVOLUTION")),
      BigInt(deployment.genesisStart),
      parseEther(config.emission.evolutionWeeklyCapApool),
      parseEther(config.emission.evolutionLifetimeCapApool),
      deployment.deployer,
    ],
    contributionLedger: [
      BigInt(deployment.genesisStart),
      deployment.contracts.settlementRouter,
      deployment.deployer,
    ],
    proofRegistry: [
      deployment.contracts.contributionLedger,
      deployment.deployer,
    ],
    evolutionConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.releaseRegistry,
      deployment.financeInvariantHash,
      deployment.genesisRelease,
      proposalBond,
    ],
    objectiveVerifier: [],
    systemIssueGate: [
      deployment.bootstrapRoot,
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.deployer,
      deployment.bootstrapVerifierCodehash,
      deployment.dynamicValidatorRoot,
      parseEther(config.dynamicIssues.candidateBudgetCapApool),
      parseEther(config.dynamicIssues.issueBudgetCapApool),
      config.dynamicIssues.maxCandidates,
      config.dynamicIssues.maxLifetimeSeconds,
      parseEther(config.dynamicIssues.candidateAdmissionBondApool),
    ],
    transitionIssueConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.systemIssueGate,
      proposalBond,
    ],
    issueConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.systemIssueGate,
      proposalBond,
    ],
    taskMarket: [
      deployment.contracts.token,
      deployment.contracts.userEscrow,
      deployment.contracts.coreEpochVault,
      deployment.contracts.evolutionEpochVault,
      deployment.contracts.contributionLedger,
      deployment.contracts.releaseRegistry,
      deployment.contracts.capacityRegistry,
      deployment.contracts.proofRegistry,
      deployment.contracts.settlementRouter,
      deployment.contracts.systemIssueGate,
      deployment.financeInvariantHash,
      ...(deployment.contracts.policyAnchor
        ? [config.dynamicIssues.maxGovernanceMilestones]
        : []),
    ],
  };
  if (deployment.contracts.policyAnchor) {
    argumentsByKey.thresholdAuthority = [
      deployment.thresholdAuthorityOwners,
      deployment.thresholdAuthorityThreshold,
    ];
    argumentsByKey.policyAnchor = [deployment.contracts.thresholdAuthority];
    argumentsByKey.maturityAnchor = [deployment.contracts.thresholdAuthority];
  }
  exactKeys(
    argumentsByKey,
    Object.keys(deployment.contracts),
    "CANONICAL_DEPLOYMENT_ARGUMENT",
  );
  return argumentsByKey;
}

export function canonicalCreationInput({
  key,
  deployment,
  config,
}) {
  const type = CONTRACT_TYPES[key];
  if (!type) {
    throw new Error(`V44_TESTNET_DEPLOYMENT_KEY_INVALID:${key}`);
  }
  const compiled = artifact(type);
  const argumentsByKey = canonicalDeploymentArguments({
    deployment,
    config,
  });
  return encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: argumentsByKey[key],
  });
}

export function assertCanonicalCreationInput({
  key,
  deployment,
  config,
  input,
}) {
  const expected = canonicalCreationInput({ key, deployment, config });
  if (
    typeof input !== "string" ||
    input.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(
      `V44_TESTNET_DEPLOYMENT_CONSTRUCTOR_INVALID:${key}`,
    );
  }
  return expected;
}

function resultField(result, name, index) {
  return result?.[name] ?? result?.[index];
}

function decodedArgument(decoded, index) {
  if (!Array.isArray(decoded?.args)) {
    throw new Error("V44_TESTNET_TRANSACTION_ARGUMENTS_INVALID");
  }
  return decoded.args[index];
}

function matchingDecodedEvents({
  receipt,
  deployment,
  contractKey,
  eventName,
}) {
  const address = deployment.contracts[contractKey].toLowerCase();
  const abi = artifact(CONTRACT_TYPES[contractKey]).abi;
  const decoded = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    try {
      const event = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (event.eventName === eventName) decoded.push(event);
    } catch {
      // Logs from other events on the same contract are intentionally skipped.
    }
  }
  return decoded;
}

function errorSelector(errorName) {
  return keccak256(toBytes(`${errorName}()`)).slice(0, 10).toLowerCase();
}

function findRevertData(value, seen = new Set()) {
  if (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{8,}$/u.test(value)
  ) {
    return value.toLowerCase();
  }
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of ["data", "cause", "error", "details", "body"]) {
    const found = findRevertData(value[key], seen);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    const found = findRevertData(nested, seen);
    if (found) return found;
  }
  return null;
}

async function requireReplayError({
  client,
  transaction,
  receipt,
  expectedError,
}) {
  if (receipt.blockNumber === 0n) {
    throw new Error("V44_TESTNET_REVERT_REPLAY_BLOCK_INVALID");
  }
  let replaySucceeded = false;
  try {
    await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.input,
      // A reverted transaction leaves no state, but later transactions in the
      // same block can. Replaying against the prior block proves that the
      // claimed failure condition existed before the evidence transaction.
      blockNumber: receipt.blockNumber - 1n,
    });
    replaySucceeded = true;
  } catch (error) {
    const revertData = findRevertData(error);
    if (
      !revertData ||
      revertData.slice(0, 10) !== errorSelector(expectedError)
    ) {
      throw new Error(
        `V44_TESTNET_REVERT_REASON_INVALID:${expectedError}`,
      );
    }
  }
  if (replaySucceeded) {
    throw new Error("V44_TESTNET_REVERT_REPLAY_SUCCEEDED");
  }
}

export function assertClosedJobSemantic({
  category,
  decodedFunction,
  receipt,
  deployment,
}) {
  const jobId = decodedArgument(decodedFunction, 0);
  const expectedState = {
    REFUND_COMPLETED: JOB_STATE.EXPIRED,
    NO_QUORUM_REFUND: JOB_STATE.REFUNDED,
    REJECTION_PRESERVED: JOB_STATE.REJECTED,
  }[category];
  if (expectedState === undefined) {
    throw new Error(`V44_TESTNET_JOB_CLOSE_CATEGORY_INVALID:${category}`);
  }
  const closes = matchingDecodedEvents({
    receipt,
    deployment,
    contractKey: "taskMarket",
    eventName: "JobClosed",
  }).filter(
    (event) =>
      event.args.jobId.toLowerCase() === jobId.toLowerCase() &&
      Number(event.args.state) === expectedState,
  );
  if (closes.length !== 1) {
    throw new Error(`V44_TESTNET_JOB_CLOSE_STATE_INVALID:${category}`);
  }
  return { jobId, expectedState };
}

export async function verifyObservationSemantic({
  client,
  deployment,
  entry,
  rule,
  receipt,
  transaction,
  read,
}) {
  const abi = artifact(CONTRACT_TYPES[rule.contractKey]).abi;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi, data: transaction.input });
  } catch {
    throw new Error(
      `V44_TESTNET_FUNCTION_DECODE_INVALID:${entry.category}`,
    );
  }
  if (decoded.functionName !== rule.functionName) {
    throw new Error(
      `V44_TESTNET_FUNCTION_MISMATCH:${entry.category}`,
    );
  }

  if (rule.transactionStatus === "reverted") {
    await requireReplayError({
      client,
      transaction,
      receipt,
      expectedError: rule.expectedRevertError,
    });
  }
  const semanticBlock =
    rule.transactionStatus === "reverted"
      ? receipt.blockNumber - 1n
      : receipt.blockNumber;

  if (
    [
      "BOOTSTRAP_SETTLEMENT",
      "SYSTEM_SETTLEMENT",
      "EXTERNAL_SETTLEMENT",
    ].includes(rule.semantic)
  ) {
    const jobId = decodedArgument(decoded, 0);
    const milestoneIndex = decodedArgument(decoded, 1);
    const job = await read(
      "taskMarket",
      "jobs",
      [jobId],
      receipt.blockNumber,
    );
    const funding = Number(resultField(job, "funding", 1));
    const governanceEligible = await read(
      "taskMarket",
      "jobGovernanceEligible",
      [jobId],
      receipt.blockNumber,
    );
    const settlementMatched = matchingDecodedEvents({
      receipt,
      deployment,
      contractKey: "taskMarket",
      eventName: "MilestoneSettled",
    }).some(
      (event) =>
        event.args.jobId.toLowerCase() === jobId.toLowerCase() &&
        Number(event.args.milestone) === Number(milestoneIndex),
    );
    const correctLane =
      (
        rule.semantic === "BOOTSTRAP_SETTLEMENT" &&
        funding === FUNDING.EVOLUTION &&
        governanceEligible === false
      ) ||
      (
        rule.semantic === "SYSTEM_SETTLEMENT" &&
        [FUNDING.CORE, FUNDING.EVOLUTION].includes(funding) &&
        governanceEligible === true
      ) ||
      (
        rule.semantic === "EXTERNAL_SETTLEMENT" &&
        funding === FUNDING.EXTERNAL
      );
    if (!settlementMatched || !correctLane) {
      throw new Error(
        `V44_TESTNET_SETTLEMENT_SEMANTIC_INVALID:${entry.category}`,
      );
    }
    return;
  }

  if (
    [
      "JOB_CLOSED_EXPIRED",
      "JOB_CLOSED_NO_QUORUM_REFUND",
      "JOB_CLOSED_REJECTED",
    ].includes(rule.semantic)
  ) {
    assertClosedJobSemantic({
      category: entry.category,
      decodedFunction: decoded,
      receipt,
      deployment,
    });
    return;
  }

  if (rule.semantic === "DUPLICATE_SETTLEMENT") {
    const jobId = decodedArgument(decoded, 0);
    const milestoneIndex = decodedArgument(decoded, 1);
    const [job, milestone] = await Promise.all([
      read("taskMarket", "jobs", [jobId], receipt.blockNumber),
      read(
        "taskMarket",
        "milestones",
        [jobId, milestoneIndex],
        receipt.blockNumber,
      ),
    ]);
    if (
      Number(resultField(job, "state", 2)) !== JOB_STATE.SETTLED ||
      Number(resultField(milestone, "state", 16)) !== 4
    ) {
      throw new Error("V44_TESTNET_DUPLICATE_SETTLEMENT_STATE_INVALID");
    }
    return;
  }

  if (rule.semantic === "FINALIZED_ISSUE_REPLAY") {
    const issue = decodedArgument(decoded, 4);
    const issueId = resultField(issue, "issueId", 0);
    const [group, termsHash, usage] = await Promise.all([
      read(
        "contributionLedger",
        "operatorGroup",
        [transaction.from],
        semanticBlock,
      ),
      read("systemIssueGate", "hashIssue", [issue], semanticBlock),
      read("systemIssueGate", "usage", [issueId], semanticBlock),
    ]);
    const usageTermsHash = resultField(usage, "termsHash", 0);
    const finalized =
      group !== ZERO_BYTES32 &&
      usageTermsHash.toLowerCase() === termsHash.toLowerCase() &&
      (await read(
        "systemIssueGate",
        "candidateFinalized",
        [issueId, group],
        semanticBlock,
      ));
    if (!finalized) {
      throw new Error("V44_TESTNET_ISSUE_REPLAY_STATE_INVALID");
    }
    return;
  }

  if (rule.semantic === "EMISSION_CAP_EXCEEDED") {
    const funding = Number(decodedArgument(decoded, 0));
    const budget = BigInt(decodedArgument(decoded, 1));
    const issue = decodedArgument(decoded, 4);
    const terms = decodedArgument(decoded, 6);
    const requested = terms.reduce(
      (total, term) =>
        total +
        BigInt(resultField(term, "allocation", 6)) +
        BigInt(resultField(term, "keeperFee", 8)),
      0n,
    );
    const vaultKey =
      funding === FUNDING.CORE
        ? "coreEpochVault"
        : funding === FUNDING.EVOLUTION
          ? "evolutionEpochVault"
          : null;
    if (!vaultKey || requested === 0n || budget < requested) {
      throw new Error("V44_TESTNET_CAP_PROBE_INVALID");
    }
    const issueId = resultField(issue, "issueId", 0);
    const candidateBudgetCap = BigInt(
      resultField(issue, "candidateBudgetCap", 7),
    );
    const totalBudgetCap = BigInt(
      resultField(issue, "totalBudgetCap", 8),
    );
    const maxCandidates = Number(resultField(issue, "maxCandidates", 9));
    const termsHash = await read(
      "systemIssueGate",
      "hashIssue",
      [issue],
      semanticBlock,
    );
    const [usage, transitionApproved, matureApproved, group] =
      await Promise.all([
        read("systemIssueGate", "usage", [issueId], semanticBlock),
        read(
          "systemIssueGate",
          "transitionApprovedIssueHash",
          [termsHash],
          semanticBlock,
        ),
        read(
          "systemIssueGate",
          "approvedIssueHash",
          [termsHash],
          semanticBlock,
        ),
        read(
          "contributionLedger",
          "operatorGroup",
          [transaction.from],
          semanticBlock,
        ),
      ]);
    const usageTermsHash = resultField(usage, "termsHash", 0);
    const committedBudget = BigInt(
      resultField(usage, "committedBudget", 1),
    );
    const candidates = Number(resultField(usage, "candidates", 2));
    const groupAlreadyUsed =
      group === ZERO_BYTES32
        ? true
        : await read(
            "systemIssueGate",
            "groupUsed",
            [issueId, group],
            semanticBlock,
          );
    if (
      (!transitionApproved && !matureApproved) ||
      (
        usageTermsHash !== ZERO_BYTES32 &&
        usageTermsHash.toLowerCase() !== termsHash.toLowerCase()
      ) ||
      groupAlreadyUsed ||
      requested > candidateBudgetCap ||
      committedBudget + requested > totalBudgetCap ||
      candidates >= maxCandidates
    ) {
      throw new Error("V44_TESTNET_CAP_PROBE_GATE_PRECONDITION_INVALID");
    }
    const epoch = await read(
      vaultKey,
      "currentEpoch",
      [],
      semanticBlock,
    );
    const [
      epochEmitted,
      totalReserved,
      weeklyCap,
      totalEmitted,
      lifetimeCap,
    ] = await Promise.all([
      read(vaultKey, "epochEmitted", [epoch], semanticBlock),
      read(vaultKey, "totalReserved", [], semanticBlock),
      read(vaultKey, "weeklyCap", [], semanticBlock),
      read(vaultKey, "totalEmitted", [], semanticBlock),
      read(vaultKey, "lifetimeCap", [], semanticBlock),
    ]);
    if (
      BigInt(epochEmitted) + BigInt(totalReserved) + requested <=
        BigInt(weeklyCap) &&
      BigInt(totalEmitted) + BigInt(totalReserved) + requested <=
        BigInt(lifetimeCap)
    ) {
      throw new Error("V44_TESTNET_CAP_NOT_EXCEEDED");
    }
  }
}

export async function collectLiveRpcEvidence({
  rpcUrl,
  deployment,
  observations,
  policy,
  verificationBlockNumber,
}) {
  if (typeof rpcUrl !== "string" || rpcUrl.trim().length === 0) {
    throw new Error("V44_TESTNET_RPC_URL_MISSING");
  }
  const client = createPublicClient({
    chain: {
      id: TESTNET_CHAIN_ID,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
  });
  if ((await client.getChainId()) !== TESTNET_CHAIN_ID) {
    throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
  }
  const currentLatestBlock = await client.getBlockNumber();
  if (
    verificationBlockNumber !== undefined &&
    (!Number.isSafeInteger(Number(verificationBlockNumber)) ||
      Number(verificationBlockNumber) <= 0)
  ) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_INVALID");
  }
  const verificationBlock =
    verificationBlockNumber === undefined
      ? currentLatestBlock
      : BigInt(verificationBlockNumber);
  if (verificationBlock > currentLatestBlock) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_IN_FUTURE");
  }
  if (verificationBlock < BigInt(deployment.deploymentBlock)) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_BEFORE_DEPLOYMENT");
  }
  const configEvidence = loadAndValidateConfig();
  if (configEvidence.configSha256 !== deployment.configSha256) {
    throw new Error("V44_TESTNET_LIVE_CONFIG_MISMATCH");
  }
  const expectedGenesisRelease = keccak256(
    encodeAbiParameters(
      [{ type: "bytes20" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        `0x${deployment.sourceCommit}`,
        deployment.genesisModuleHash,
        deployment.genesisManifestHash,
      ],
    ),
  );
  if (
    expectedGenesisRelease.toLowerCase() !==
    deployment.genesisRelease.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_GENESIS_RELEASE_INVALID");
  }
  for (const [key, address] of Object.entries(deployment.contracts)) {
    const type = CONTRACT_TYPES[key];
    const compiled = artifact(type);
    const [code, receipt, transaction] = await Promise.all([
      client.getCode({ address, blockNumber: verificationBlock }),
      client.getTransactionReceipt({
        hash: deployment.deploymentTransactions[key],
      }),
      client.getTransaction({
        hash: deployment.deploymentTransactions[key],
      }),
    ]);
    assertCanonicalCreationInput({
      key,
      deployment,
      config: configEvidence.config,
      input: transaction.input,
    });
    if (
      !code ||
      code === "0x" ||
      keccak256(code).toLowerCase() !==
        deployment.deployedCodeHashes[key].toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_LIVE_CODE_MISMATCH:${key}`);
    }
    if (
      receipt.status !== "success" ||
      receipt.contractAddress?.toLowerCase() !== address.toLowerCase() ||
      transaction.to !== null ||
      transaction.from.toLowerCase() !== deployment.deployer.toLowerCase() ||
      keccak256(transaction.input).toLowerCase() !==
        deployment.creationInputHashes[key].toLowerCase() ||
      keccak256(compiled.bytecode).toLowerCase() !==
        deployment.artifactCreationBytecodeHashes[type].toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_PROVENANCE_INVALID:${key}`);
    }
  }

  async function read(key, functionName, args = [], blockNumber) {
    return client.readContract({
      address: deployment.contracts[key],
      abi: artifact(CONTRACT_TYPES[key]).abi,
      functionName,
      args,
      blockNumber:
        blockNumber === undefined ? verificationBlock : blockNumber,
    });
  }

  function same(actual, expected) {
    if (typeof actual === "string" && typeof expected === "string") {
      return actual.toLowerCase() === expected.toLowerCase();
    }
    return actual === expected;
  }

  async function requireRead(key, functionName, expected, args = []) {
    const actual = await read(key, functionName, args);
    if (!same(actual, expected)) {
      throw new Error(
        `V44_TESTNET_WIRING_MISMATCH:${key}.${functionName}:${actual}:${expected}`,
      );
    }
  }

  const config = configEvidence.config;
  const proposalBond = parseEther(config.consensus.proposalBondApool);
  const wiringChecks = [
    ["token", "configurationAuthority", ZERO_ADDRESS],
    ["token", "coreEpochVault", deployment.contracts.coreEpochVault],
    [
      "token",
      "evolutionEpochVault",
      deployment.contracts.evolutionEpochVault,
    ],
    ["token", "MAX_SUPPLY", parseEther(config.token.maxSupplyApool)],
    ["userEscrow", "configurationAuthority", ZERO_ADDRESS],
    ["userEscrow", "token", deployment.contracts.token],
    ["userEscrow", "market", deployment.contracts.taskMarket],
    ["coreEpochVault", "configurationAuthority", ZERO_ADDRESS],
    ["coreEpochVault", "token", deployment.contracts.token],
    ["coreEpochVault", "market", deployment.contracts.taskMarket],
    ["coreEpochVault", "genesisStart", BigInt(deployment.genesisStart)],
    [
      "coreEpochVault",
      "weeklyCap",
      parseEther(config.emission.coreWeeklyCapApool),
    ],
    [
      "coreEpochVault",
      "lifetimeCap",
      parseEther(config.emission.coreLifetimeCapApool),
    ],
    ["evolutionEpochVault", "configurationAuthority", ZERO_ADDRESS],
    ["evolutionEpochVault", "token", deployment.contracts.token],
    ["evolutionEpochVault", "market", deployment.contracts.taskMarket],
    ["evolutionEpochVault", "genesisStart", BigInt(deployment.genesisStart)],
    [
      "evolutionEpochVault",
      "weeklyCap",
      parseEther(config.emission.evolutionWeeklyCapApool),
    ],
    [
      "evolutionEpochVault",
      "lifetimeCap",
      parseEther(config.emission.evolutionLifetimeCapApool),
    ],
    ["capacityRegistry", "configurationAuthority", ZERO_ADDRESS],
    ["capacityRegistry", "market", deployment.contracts.taskMarket],
    ["proofRegistry", "configurationAuthority", ZERO_ADDRESS],
    ["proofRegistry", "market", deployment.contracts.taskMarket],
    ["proofRegistry", "ledger", deployment.contracts.contributionLedger],
    ["contributionLedger", "bootstrapAuthority", ZERO_ADDRESS],
    [
      "contributionLedger",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    [
      "contributionLedger",
      "genesisStart",
      BigInt(deployment.genesisStart),
    ],
    [
      "contributionLedger",
      "isActiveSource",
      true,
      [deployment.contracts.settlementRouter],
    ],
    ["releaseRegistry", "configurationAuthority", ZERO_ADDRESS],
    [
      "releaseRegistry",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    ["settlementRouter", "configurationAuthority", ZERO_ADDRESS],
    [
      "settlementRouter",
      "ledger",
      deployment.contracts.contributionLedger,
    ],
    [
      "settlementRouter",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    ["settlementRouter", "market", deployment.contracts.taskMarket],
    ["systemIssueGate", "configurationAuthority", ZERO_ADDRESS],
    ["systemIssueGate", "market", deployment.contracts.taskMarket],
    [
      "systemIssueGate",
      "transitionConsensus",
      deployment.contracts.transitionIssueConsensus,
    ],
    [
      "systemIssueGate",
      "matureConsensus",
      deployment.contracts.issueConsensus,
    ],
    ["systemIssueGate", "bootstrapRoot", deployment.bootstrapRoot],
    [
      "systemIssueGate",
      "dynamicValidatorRoot",
      deployment.dynamicValidatorRoot,
    ],
    [
      "systemIssueGate",
      "dynamicVerifierCodehash",
      deployment.bootstrapVerifierCodehash,
    ],
    [
      "systemIssueGate",
      "dynamicCandidateBudgetCap",
      parseEther(config.dynamicIssues.candidateBudgetCapApool),
    ],
    [
      "systemIssueGate",
      "dynamicIssueBudgetCap",
      parseEther(config.dynamicIssues.issueBudgetCapApool),
    ],
    [
      "systemIssueGate",
      "dynamicCandidateBond",
      parseEther(config.dynamicIssues.candidateAdmissionBondApool),
    ],
    [
      "transitionIssueConsensus",
      "validatorRoot",
      deployment.dynamicValidatorRoot,
    ],
    ["transitionIssueConsensus", "minimumBond", proposalBond],
    ["issueConsensus", "minimumBond", proposalBond],
    ["evolutionConsensus", "minimumProposalBond", proposalBond],
    [
      "evolutionConsensus",
      "financeInvariantHash",
      deployment.financeInvariantHash,
    ],
    ["taskMarket", "token", deployment.contracts.token],
    ["taskMarket", "userEscrow", deployment.contracts.userEscrow],
    ["taskMarket", "coreEpochVault", deployment.contracts.coreEpochVault],
    [
      "taskMarket",
      "evolutionEpochVault",
      deployment.contracts.evolutionEpochVault,
    ],
    [
      "taskMarket",
      "contributionLedger",
      deployment.contracts.contributionLedger,
    ],
    ["taskMarket", "releaseRegistry", deployment.contracts.releaseRegistry],
    ["taskMarket", "capacityRegistry", deployment.contracts.capacityRegistry],
    ["taskMarket", "proofRegistry", deployment.contracts.proofRegistry],
    [
      "taskMarket",
      "settlementRouter",
      deployment.contracts.settlementRouter,
    ],
    ["taskMarket", "systemIssueGate", deployment.contracts.systemIssueGate],
    [
      "taskMarket",
      "financeInvariantHash",
      deployment.financeInvariantHash,
    ],
  ];
  for (const [key, functionName, expected, args = []] of wiringChecks) {
    await requireRead(key, functionName, expected, args);
  }
  const verifierCode = await client.getCode({
    address: deployment.contracts.objectiveVerifier,
    blockNumber: verificationBlock,
  });
  if (
    !verifierCode ||
    verifierCode === "0x" ||
    keccak256(verifierCode).toLowerCase() !==
      deployment.bootstrapVerifierCodehash.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_VERIFIER_CODEHASH_MISMATCH");
  }

  const contributors = new Set();
  const blocks = new Set();
  let latestObservedBlock = 0n;
  let earliestObservedBlock = null;
  let earliestObservedTimestamp = Number.POSITIVE_INFINITY;
  let latestObservedTimestamp = 0;
  for (const entry of observations.observations) {
    const rule = policy.categories[entry.category];
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: entry.txHash }),
      client.getTransaction({ hash: entry.txHash }),
    ]);
    const expectedStatus =
      rule.transactionStatus === "success" ? "success" : "reverted";
    if (
      receipt.status !== expectedStatus ||
      transaction.to?.toLowerCase() !==
        deployment.contracts[rule.contractKey].toLowerCase() ||
      receipt.blockNumber < BigInt(deployment.deploymentBlock)
    ) {
      throw new Error(`V44_TESTNET_RECEIPT_INVALID:${entry.txHash}`);
    }
    await verifyObservationSemantic({
      client,
      deployment,
      entry,
      rule,
      receipt,
      transaction,
      read,
    });
    for (const expectedEvent of rule.requiredEvents) {
      const address =
        deployment.contracts[expectedEvent.contractKey].toLowerCase();
      const topic = eventTopic(expectedEvent.signature);
      const matchingLogs = receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === address &&
          log.topics[0]?.toLowerCase() === topic,
      );
      if (matchingLogs.length === 0) {
        throw new Error(
          `V44_TESTNET_REQUIRED_EVENT_MISSING:${entry.category}:${expectedEvent.signature}`,
        );
      }
      if (
        expectedEvent.signature.startsWith("OutcomeRecorded(") ||
        expectedEvent.signature.startsWith("PerformanceRecorded(")
      ) {
        for (const log of matchingLogs) {
          const contributor = indexedAddress(log.topics[2]);
          if (contributor) contributors.add(contributor);
        }
      }
    }
    blocks.add(receipt.blockNumber.toString());
    if (receipt.blockNumber > latestObservedBlock) {
      latestObservedBlock = receipt.blockNumber;
    }
    if (
      earliestObservedBlock === null ||
      receipt.blockNumber < earliestObservedBlock
    ) {
      earliestObservedBlock = receipt.blockNumber;
    }
    if (entry.blockNumber !== Number(receipt.blockNumber)) {
      throw new Error(`V44_TESTNET_OBSERVATION_BLOCK_MISMATCH:${entry.txHash}`);
    }
  }

  for (const blockNumber of blocks) {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    const timestamp = Number(block.timestamp) * 1000;
    earliestObservedTimestamp = Math.min(earliestObservedTimestamp, timestamp);
    latestObservedTimestamp = Math.max(latestObservedTimestamp, timestamp);
  }
  const operatorGroups = new Set();
  for (const contributor of contributors) {
    const group = await client.readContract({
      address: deployment.contracts.contributionLedger,
      abi: artifact(CONTRACT_TYPES.contributionLedger).abi,
      functionName: "operatorGroup",
      args: [contributor],
      blockNumber: verificationBlock,
    });
    if (HASH_PATTERN.test(group) && !/^0x0{64}$/u.test(group)) {
      operatorGroups.add(group.toLowerCase());
    }
  }
  return {
    liveRpcVerified: true,
    verifiedTransactionCount: observations.observations.length,
    contributingAgents: [...contributors].sort(),
    contributingOperatorGroups: [...operatorGroups].sort(),
    latestObservedBlock: Number(latestObservedBlock),
    earliestObservedBlock:
      earliestObservedBlock === null ? null : Number(earliestObservedBlock),
    earliestObservedTimestamp,
    latestObservedTimestamp,
    latestBlock: Number(verificationBlock),
    indexerLagBlocks: Number(verificationBlock - latestObservedBlock),
  };
}

function blocker(blockers, condition, code) {
  if (!condition) blockers.push(code);
}

export function reconcileRpcEvidenceSnapshots({
  primaryUrl,
  secondaryUrl,
  primary,
  secondary,
}) {
  const primaryOrigin = new URL(primaryUrl).origin;
  const secondaryOrigin = new URL(secondaryUrl).origin;
  if (primaryOrigin === secondaryOrigin) {
    throw new Error("V44_TESTNET_RPC_PROVIDER_INDEPENDENCE_REQUIRED");
  }
  const comparable = (value) => ({
    liveRpcVerified: value.liveRpcVerified,
    verifiedTransactionCount: value.verifiedTransactionCount,
    contributingAgents: value.contributingAgents,
    contributingOperatorGroups: value.contributingOperatorGroups,
    latestObservedBlock: value.latestObservedBlock,
    earliestObservedBlock: value.earliestObservedBlock,
    earliestObservedTimestamp: value.earliestObservedTimestamp,
    latestObservedTimestamp: value.latestObservedTimestamp,
    latestBlock: value.latestBlock,
    indexerLagBlocks: value.indexerLagBlocks,
  });
  const primaryComparable = comparable(primary);
  const secondaryComparable = comparable(secondary);
  if (sha256Json(primaryComparable) !== sha256Json(secondaryComparable)) {
    throw new Error("V44_TESTNET_RPC_EVIDENCE_CONFLICT");
  }
  return {
    ...primary,
    providerCount: 2,
    providerOrigins: [primaryOrigin, secondaryOrigin].sort(),
    reconciliationRoot: sha256Json(primaryComparable),
  };
}

export async function collectMaturityProviderSnapshot({
  rpcUrl,
  deployment,
  authorization,
  maturityPolicy = null,
  client: suppliedClient = null,
}) {
  const origin = new URL(rpcUrl).origin;
  const declaredProvider = authorization?.providerSnapshots?.find(
    (provider) => provider.origin === origin,
  );
  if (
    !declaredProvider ||
    typeof declaredProvider.providerOperatorId !== "string" ||
    !Number.isSafeInteger(declaredProvider.finalizedBlockNumber)
  ) {
    throw new Error("V44_MATURITY_COLLECTION_INPUT_INVALID");
  }
  const blockNumber = BigInt(declaredProvider.finalizedBlockNumber);
  const client =
    suppliedClient ?? createPublicClient({ transport: http(rpcUrl) });
  const [block, finalizedHead] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  if (
    blockNumber > finalizedHead.number ||
    block.hash?.toLowerCase() !==
      declaredProvider.finalizedBlockHash?.toLowerCase()
  ) {
    throw new Error("V44_MATURITY_COLLECTION_BLOCK_MISMATCH");
  }
  const ledgerAbi = artifact(CONTRACT_TYPES.contributionLedger).abi;
  const outcomeRecordedEvent = ledgerAbi.find(
    (entry) => entry.type === "event" && entry.name === "OutcomeRecorded",
  );
  if (!outcomeRecordedEvent) {
    throw new Error("V44_MATURITY_OUTCOME_EVENT_MISSING");
  }
  const read = (functionName, args = []) =>
    client.readContract({
      address: deployment.contracts.contributionLedger,
      abi: ledgerAbi,
      functionName,
      args,
      blockNumber,
    });
  const [successfulSystemSettlements, eligibleAgentCount, eligibleGroupCount, epoch] =
    await Promise.all([
      read("successfulSettlementCount"),
      read("eligibleAgentCount"),
      read("eligibleGroupCount"),
      // Mature IssueConsensus snapshots this exact epoch. Using the latest
      // active epoch would let an attacker present a diversified readiness
      // population while the first mature vote still uses an older,
      // concentrated epoch.
      read("governanceSnapshotEpoch"),
    ]);
  const outcomeLogs = await client.getLogs({
    address: deployment.contracts.contributionLedger,
    event: outcomeRecordedEvent,
    fromBlock: BigInt(deployment.deploymentBlock),
    toBlock: blockNumber,
    strict: true,
  });
  const successfulAgents = new Set(
    outcomeLogs
      .filter((log) => log.args?.successful === true)
      .map((log) => getAddress(log.args.agent).toLowerCase()),
  );
  const maintainerAgents = new Set(
    (
      maturityPolicy?.readinessEvidencePolicy?.maintainerAgents ?? []
    ).map((agent) => getAddress(agent).toLowerCase()),
  );
  const votingAgents = [];
  for (const candidate of [...successfulAgents].sort()) {
    const address = getAddress(candidate);
    const [operatorGroup, workPower] = await Promise.all([
      read("operatorGroup", [address]),
      read("votingPowerAt", [address, epoch, 8]),
    ]);
    if (BigInt(workPower) <= 0n) continue;
    if (maintainerAgents.has(address.toLowerCase())) {
      throw new Error("V44_MATURITY_MAINTAINER_HAS_WORK_POWER");
    }
    votingAgents.push({
      agent: address.toLowerCase(),
      operatorGroup: operatorGroup.toLowerCase(),
      workPower: workPower.toString(),
    });
  }
  votingAgents.sort((left, right) => left.agent.localeCompare(right.agent));
  if (votingAgents.length === 0) {
    throw new Error("V44_MATURITY_VOTING_POPULATION_EMPTY");
  }
  const positiveVotingGroups = new Set(
    votingAgents.map((agent) => agent.operatorGroup),
  );
  const totalWorkPower = votingAgents.reduce(
    (total, agent) => total + BigInt(agent.workPower),
    0n,
  );
  return {
    identity: declaredProvider.providerOperatorId,
    providerOperatorId: declaredProvider.providerOperatorId,
    origin,
    finalizedBlockNumber: Number(block.number),
    finalizedBlockHash: block.hash.toLowerCase(),
    providerFinalizedHeadNumber: Number(finalizedHead.number),
    providerFinalizedHeadHash: finalizedHead.hash.toLowerCase(),
    chainSnapshot: {
      successfulSystemSettlements: Number(successfulSystemSettlements),
      governanceSnapshotEpoch: Number(epoch),
      eligibleAgentCount: Number(eligibleAgentCount),
      eligibleGroupCount: Number(eligibleGroupCount),
      populationComplete: true,
      populationFromBlock: deployment.deploymentBlock,
      populationToBlock: Number(blockNumber),
      populationSourceEventCount: outcomeLogs.length,
      successfulAgentAddressCount: successfulAgents.size,
      positiveVotingAgentCount: votingAgents.length,
      positiveVotingGroupCount: positiveVotingGroups.size,
      totalWorkPower: totalWorkPower.toString(),
      populationRoot: sha256Json(votingAgents),
      votingAgents,
    },
  };
}

function resolvePinnedEvidencePath(relativePath, label) {
  const resolved = path.resolve(ROOT, relativePath ?? "");
  const rootPrefix = `${path.resolve(ROOT)}${path.sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(rootPrefix)) {
    throw new Error(`V44_MATURITY_${label}_PATH_INVALID`);
  }
  return resolved;
}

export async function collectGovernanceDryRunChecks({
  client,
  deployment,
  transcript,
  checkPolicy,
  maximumFinalizedBlockNumber,
}) {
  if (
    !client ||
    !Array.isArray(transcript?.checks) ||
    !Array.isArray(checkPolicy) ||
    !Number.isSafeInteger(maximumFinalizedBlockNumber)
  ) {
    throw new Error("V44_MATURITY_DRY_RUN_COLLECTION_INPUT_INVALID");
  }
  const locators = new Map(
    transcript.checks.map((check) => [check.id, check.transactionHash]),
  );
  const trustedChecks = [];
  const seenTransactions = new Set();
  const linkage = {
    proposalId: null,
    issueId: null,
    issueTermsHash: null,
    jobId: null,
    previousBlockNumber: null,
    previousTransactionIndex: null,
  };
  for (const policy of checkPolicy) {
    const transactionHash = locators.get(policy.id);
    if (!HASH_PATTERN.test(transactionHash ?? "")) {
      throw new Error("V44_MATURITY_DRY_RUN_TRANSACTION_INVALID");
    }
    if (seenTransactions.has(transactionHash.toLowerCase())) {
      throw new Error("V44_MATURITY_DRY_RUN_TRANSACTION_REUSED");
    }
    seenTransactions.add(transactionHash.toLowerCase());
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: transactionHash }),
      client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    const expectedAddress = getAddress(
      deployment.contracts[policy.contractKey],
    );
    const contractAbi = artifact(CONTRACT_TYPES[policy.contractKey]).abi;
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: contractAbi, data: transaction.input });
    } catch {
      throw new Error("V44_MATURITY_DRY_RUN_CALLDATA_INVALID");
    }
    const blockNumber = Number(receipt.blockNumber);
    if (
      transaction.to?.toLowerCase() !== expectedAddress.toLowerCase() ||
      decoded.functionName !== policy.functionName ||
      receipt.status !== policy.expectedStatus ||
      !Number.isSafeInteger(blockNumber) ||
      blockNumber > transcript.finalizedBlockNumber ||
      blockNumber > maximumFinalizedBlockNumber
    ) {
      throw new Error("V44_MATURITY_DRY_RUN_TRANSACTION_MISMATCH");
    }
    const transactionIndex = Number(receipt.transactionIndex ?? 0);
    if (
      linkage.previousBlockNumber !== null &&
      (blockNumber < linkage.previousBlockNumber ||
        (blockNumber === linkage.previousBlockNumber &&
          transactionIndex <= linkage.previousTransactionIndex))
    ) {
      throw new Error("V44_MATURITY_DRY_RUN_ORDER_INVALID");
    }
    linkage.previousBlockNumber = blockNumber;
    linkage.previousTransactionIndex = transactionIndex;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) {
      throw new Error("V44_MATURITY_DRY_RUN_BLOCK_MISMATCH");
    }
    const requiredEvents = policy.requiredEvents.map((requiredEvent) => {
      const eventAddress = getAddress(
        deployment.contracts[requiredEvent.contractKey],
      );
      const topic0 = eventTopic(requiredEvent.signature);
      const log = receipt.logs.find(
        (candidate) =>
          candidate.address?.toLowerCase() === eventAddress.toLowerCase() &&
          candidate.topics?.[0]?.toLowerCase() === topic0,
      );
      if (!log) {
        throw new Error("V44_MATURITY_DRY_RUN_EVENT_MISSING");
      }
      return {
        contractKey: requiredEvent.contractKey,
        signature: requiredEvent.signature,
        address: eventAddress.toLowerCase(),
        topic0,
        logIndex: Number(log.logIndex),
        dataHash: keccak256(log.data),
      };
    });
    const stateReads = [];
    if (policy.id === "proposal-bond-funded") {
      const minimumBond = await client.readContract({
        address: deployment.contracts.transitionIssueConsensus,
        abi: artifact(CONTRACT_TYPES.transitionIssueConsensus).abi,
        functionName: "minimumBond",
        blockNumber: receipt.blockNumber,
      });
      if (
        decoded.args[0].toLowerCase() !==
          deployment.contracts.transitionIssueConsensus.toLowerCase() ||
        BigInt(decoded.args[1]) < BigInt(minimumBond)
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_BOND_INVALID");
      }
    }
    if (policy.id === "transition-issue-proposed") {
      const eventAbi = artifact(CONTRACT_TYPES.transitionIssueConsensus).abi;
      const proposedLog = receipt.logs.find(
        (candidate) =>
          candidate.address.toLowerCase() ===
            deployment.contracts.transitionIssueConsensus.toLowerCase() &&
          candidate.topics[0]?.toLowerCase() ===
            eventTopic("IssueProposed(uint256,bytes32,address,bytes32)"),
      );
      const proposed = decodeEventLog({
        abi: eventAbi,
        eventName: "IssueProposed",
        data: proposedLog.data,
        topics: proposedLog.topics,
        strict: true,
      }).args;
      const computedHash = await client.readContract({
        address: deployment.contracts.systemIssueGate,
        abi: artifact(CONTRACT_TYPES.systemIssueGate).abi,
        functionName: "hashIssue",
        args: [decoded.args[0]],
        blockNumber: receipt.blockNumber,
      });
      if (
        proposed.issueHash.toLowerCase() !== computedHash.toLowerCase() ||
        proposed.needEvidenceHash.toLowerCase() !==
          decoded.args[1].toLowerCase()
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_PROPOSAL_INVALID");
      }
      linkage.proposalId = BigInt(proposed.proposalId);
      linkage.issueId = decoded.args[0].issueId.toLowerCase();
      linkage.issueTermsHash = computedHash.toLowerCase();
    }
    if (policy.id === "transition-vote-revealed") {
      if (
        linkage.proposalId === null ||
        BigInt(decoded.args[0]) !== linkage.proposalId ||
        decoded.args[1] !== true ||
        decoded.args[2] === ZERO_BYTES32
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_REVEAL_INVALID");
      }
    }
    if (policy.id === "transition-issue-finalized") {
      const approvedLog = receipt.logs.find(
        (candidate) =>
          candidate.address.toLowerCase() ===
            deployment.contracts.systemIssueGate.toLowerCase() &&
          candidate.topics[0]?.toLowerCase() ===
            eventTopic("TransitionIssueApproved(bytes32)"),
      );
      const approved = decodeEventLog({
        abi: artifact(CONTRACT_TYPES.systemIssueGate).abi,
        eventName: "TransitionIssueApproved",
        data: approvedLog.data,
        topics: approvedLog.topics,
        strict: true,
      }).args;
      if (
        linkage.proposalId === null ||
        BigInt(decoded.args[0]) !== linkage.proposalId ||
        approved.issueHash.toLowerCase() !== linkage.issueTermsHash
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_FINALIZE_INVALID");
      }
    }
    if (policy.id === "recovery-job-created") {
      const createdLog = receipt.logs.find(
        (candidate) =>
          candidate.address.toLowerCase() ===
            deployment.contracts.taskMarket.toLowerCase() &&
          candidate.topics[0]?.toLowerCase() ===
            eventTopic("JobCreated(bytes32,address,uint8,uint256,bytes32,bytes32,bytes32)"),
      );
      const created = decodeEventLog({
        abi: artifact(CONTRACT_TYPES.taskMarket).abi,
        eventName: "JobCreated",
        data: createdLog.data,
        topics: createdLog.topics,
        strict: true,
      }).args;
      const computedHash = await client.readContract({
        address: deployment.contracts.systemIssueGate,
        abi: artifact(CONTRACT_TYPES.systemIssueGate).abi,
        functionName: "hashIssue",
        args: [decoded.args[4]],
        blockNumber: receipt.blockNumber,
      });
      if (
        decoded.args[4].issueId.toLowerCase() !== linkage.issueId ||
        computedHash.toLowerCase() !== linkage.issueTermsHash ||
        created.issueId.toLowerCase() !== linkage.issueId ||
        Number(created.funding) !== Number(decoded.args[0]) ||
        BigInt(created.budget) !== BigInt(decoded.args[1]) ||
        created.planHash.toLowerCase() !== decoded.args[2].toLowerCase() ||
        created.releaseId.toLowerCase() !== decoded.args[3].toLowerCase()
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_JOB_LINK_INVALID");
      }
      linkage.jobId = created.jobId.toLowerCase();
    }
    if (policy.id === "recovery-refund-and-conservation") {
      const taskMarketAbi = artifact(CONTRACT_TYPES.taskMarket).abi;
      const jobClosedTopic = eventTopic(
        "JobClosed(bytes32,uint8,uint256,uint256)",
      );
      const jobClosedLog = receipt.logs.find(
        (candidate) =>
          candidate.address?.toLowerCase() ===
            deployment.contracts.taskMarket.toLowerCase() &&
          candidate.topics?.[0]?.toLowerCase() === jobClosedTopic,
      );
      if (!jobClosedLog) {
        throw new Error("V44_MATURITY_DRY_RUN_FUND_EVENT_MISSING");
      }
      let closed;
      try {
        closed = decodeEventLog({
          abi: taskMarketAbi,
          data: jobClosedLog.data,
          topics: jobClosedLog.topics,
          strict: true,
        }).args;
      } catch {
        throw new Error("V44_MATURITY_DRY_RUN_FUND_EVENT_INVALID");
      }
      const jobId = decoded.args?.[0]?.toLowerCase?.();
      const closedJobId = closed.jobId?.toLowerCase?.();
      const job = await client.readContract({
        address: deployment.contracts.taskMarket,
        abi: taskMarketAbi,
        functionName: "jobs",
        args: [closed.jobId],
        blockNumber: receipt.blockNumber,
      });
      const budget = BigInt(job[6]);
      const paid = BigInt(job[7]);
      const eventPaid = BigInt(closed.paid);
      const returned = BigInt(closed.returnedOrReleased);
      if (
        linkage.jobId === null ||
        jobId !== linkage.jobId ||
        jobId !== closedJobId ||
        Number(job[2]) !== Number(closed.state) ||
        paid !== eventPaid ||
        paid + returned !== budget
      ) {
        throw new Error("V44_MATURITY_DRY_RUN_FUND_CONSERVATION_INVALID");
      }
      stateReads.push({
        contractKey: "taskMarket",
        functionName: "jobs",
        jobId: closedJobId,
        blockNumber,
        state: Number(job[2]),
        budget: budget.toString(),
        paid: paid.toString(),
        returnedOrReleased: returned.toString(),
      });
    }
    trustedChecks.push({
      id: policy.id,
      transactionHash: transactionHash.toLowerCase(),
      contractKey: policy.contractKey,
      functionName: policy.functionName,
      status: receipt.status,
      blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      transactionIndex,
      inputHash: keccak256(transaction.input),
      requiredEvents,
      stateReads,
    });
  }
  return trustedChecks;
}

export async function collectMaturityReadinessEvidence({
  rpcUrl,
  deployment,
  maturityPolicy,
  observations,
  trustedProviderSnapshot,
  client: suppliedClient = null,
}) {
  const origin = new URL(rpcUrl).origin;
  if (
    maturityPolicy?.configurationStatus !== "ACTIVE" ||
    trustedProviderSnapshot?.origin !== origin ||
    !Number.isSafeInteger(trustedProviderSnapshot?.finalizedBlockNumber)
  ) {
    throw new Error("V44_MATURITY_READINESS_COLLECTION_INPUT_INVALID");
  }
  const readinessPolicy = maturityPolicy.readinessEvidencePolicy;
  const blockNumber = BigInt(trustedProviderSnapshot.finalizedBlockNumber);
  const client =
    suppliedClient ?? createPublicClient({ transport: http(rpcUrl) });
  const [block, finalizedHead] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  if (
    blockNumber > finalizedHead.number ||
    block.hash?.toLowerCase() !==
      trustedProviderSnapshot.finalizedBlockHash?.toLowerCase()
  ) {
    throw new Error("V44_MATURITY_READINESS_BLOCK_MISMATCH");
  }
  const tokenAddress = getAddress(
    deployment.contracts[readinessPolicy.proposalBond.tokenContractKey],
  );
  const bondOwner = getAddress(readinessPolicy.proposalBond.owner);
  const bondSpender = getAddress(
    deployment.contracts[readinessPolicy.proposalBond.spenderContractKey],
  );
  const requiredAmount = BigInt(
    readinessPolicy.proposalBond.requiredAmountWei,
  );
  const tokenAbi = artifact(CONTRACT_TYPES.token).abi;
  const gateAbi = artifact(CONTRACT_TYPES.systemIssueGate).abi;
  const ledgerAbi = artifact(CONTRACT_TYPES.contributionLedger).abi;
  const issueConsensusAbi = artifact(
    CONTRACT_TYPES.transitionIssueConsensus,
  ).abi;
  const read = (address, abi, functionName, args = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber,
    });
  const issueTerms = readinessPolicy.recoveryIssue.issueTerms;
  const recoveryIssueId = readinessPolicy.recoveryIssue.issueId;
  if (issueTerms.issueId?.toLowerCase?.() !== recoveryIssueId.toLowerCase()) {
    throw new Error("V44_MATURITY_RECOVERY_ISSUE_ID_MISMATCH");
  }
  const recoveryAvailabilityDeadline =
    Number(block.timestamp) + maturityPolicy.minimumRecoveryAvailabilitySeconds;
  const maintainerAgents = readinessPolicy.maintainerAgents.map((agent) =>
    getAddress(agent),
  );
  const [
    balance,
    allowance,
    computedIssueHash,
    issueUsage,
    transitionApproved,
    matureApproved,
    epoch,
    onchainMinimumBond,
  ] = await Promise.all([
    read(tokenAddress, tokenAbi, "balanceOf", [bondOwner]),
    read(tokenAddress, tokenAbi, "allowance", [bondOwner, bondSpender]),
    read(
      deployment.contracts.systemIssueGate,
      gateAbi,
      "hashIssue",
      [issueTerms],
    ),
    read(
      deployment.contracts.systemIssueGate,
      gateAbi,
      "usage",
      [recoveryIssueId],
    ),
    read(
      deployment.contracts.systemIssueGate,
      gateAbi,
      "transitionApprovedIssueHash",
      [readinessPolicy.recoveryIssue.termsHash],
    ),
    read(
      deployment.contracts.systemIssueGate,
      gateAbi,
      "approvedIssueHash",
      [readinessPolicy.recoveryIssue.termsHash],
    ),
    read(
      deployment.contracts.contributionLedger,
      ledgerAbi,
      "governanceSnapshotEpoch",
    ),
    read(
      deployment.contracts.transitionIssueConsensus,
      issueConsensusAbi,
      "minimumBond",
    ),
  ]);
  if (BigInt(onchainMinimumBond) !== requiredAmount) {
    throw new Error("V44_MATURITY_PROPOSAL_BOND_MISMATCH");
  }
  const usageTermsHash = issueUsage[0].toLowerCase();
  const usageCandidates = Number(issueUsage[2]);
  const issueAvailable =
    computedIssueHash.toLowerCase() ===
      readinessPolicy.recoveryIssue.termsHash.toLowerCase() &&
    (transitionApproved === true || matureApproved === true) &&
    usageCandidates === 0 &&
    usageTermsHash === ZERO_BYTES32 &&
    Number(issueTerms.expiresAt) >= recoveryAvailabilityDeadline;
  const maintainerRows = [];
  for (const agent of maintainerAgents) {
    const units = await read(
      deployment.contracts.contributionLedger,
      ledgerAbi,
      "votingPowerAt",
      [agent, epoch, 8],
    );
    maintainerRows.push({ agent: agent.toLowerCase(), units: units.toString() });
  }
  maintainerRows.sort((left, right) => left.agent.localeCompare(right.agent));
  const maintainerUnits = maintainerRows.reduce(
    (sum, row) => sum + BigInt(row.units),
    0n,
  );
  if (
    Number(trustedProviderSnapshot.chainSnapshot?.governanceSnapshotEpoch) !==
    Number(epoch)
  ) {
    throw new Error("V44_MATURITY_GOVERNANCE_EPOCH_MISMATCH");
  }
  const transcriptPath = resolvePinnedEvidencePath(
    readinessPolicy.governanceDryRun.transcriptPath,
    "DRY_RUN_TRANSCRIPT",
  );
  const verifierPath = resolvePinnedEvidencePath(
    readinessPolicy.governanceDryRun.verifierPath,
    "DRY_RUN_VERIFIER",
  );
  if (
    !fs.existsSync(transcriptPath) ||
    sha256File(transcriptPath) !==
      readinessPolicy.governanceDryRun.transcriptSha256 ||
    sha256File(verifierPath) !==
      readinessPolicy.governanceDryRun.verifierSha256
  ) {
    throw new Error("V44_MATURITY_DRY_RUN_CONTENT_INVALID");
  }
  const transcript = readJson(transcriptPath);
  const trustedDryRunChecks = await collectGovernanceDryRunChecks({
    client,
    deployment,
    transcript,
    checkPolicy: readinessPolicy.governanceDryRun.checkPolicy,
    maximumFinalizedBlockNumber: Number(blockNumber),
  });
  const dryRun = verifyGovernanceDryRunTranscript(transcript, {
    deploymentManifestSha256: deployment.manifestSha256,
    maximumFinalizedBlockNumber: Number(blockNumber),
    trustedChecks: trustedDryRunChecks,
    checkPolicy: readinessPolicy.governanceDryRun.checkPolicy,
  });
  const incidents = observations.incidents ?? [];
  const unresolvedCriticalHigh = incidents.filter(
    (incident) =>
      ["CRITICAL", "HIGH"].includes(incident?.severity) &&
      incident?.status !== "RESOLVED",
  ).length;
  const proposalBond = {
    token: tokenAddress.toLowerCase(),
    owner: bondOwner.toLowerCase(),
    spender: bondSpender.toLowerCase(),
    requiredAmount: requiredAmount.toString(),
    onchainMinimumBond: onchainMinimumBond.toString(),
    balance: balance.toString(),
    allowance: allowance.toString(),
    blockNumber: Number(blockNumber),
  };
  proposalBond.evidenceHash = sha256AutonomyJson({
    ...proposalBond,
    blockHash: block.hash.toLowerCase(),
  });
  const recoveryIssue = {
    issueId: recoveryIssueId.toLowerCase(),
    state: issueAvailable ? "AVAILABLE" : "UNAVAILABLE",
    termsHash: computedIssueHash.toLowerCase(),
    expiresAt: Number(issueTerms.expiresAt),
    minimumAvailableUntil: recoveryAvailabilityDeadline,
  };
  recoveryIssue.evidenceHash = sha256AutonomyJson({
    ...recoveryIssue,
    transitionApproved,
    matureApproved,
    usageCandidates,
    usageTermsHash,
    blockNumber: Number(blockNumber),
    blockHash: block.hash.toLowerCase(),
  });
  return {
    proposalBond,
    recoveryIssue,
    governanceDryRun: {
      transcriptHash: sha256AutonomyJson(transcript),
      trustedChecksRoot: dryRun.trustedChecksRoot,
      finalizedBlockNumber: transcript.finalizedBlockNumber,
      verifierVersion: dryRun.verifierVersion,
      passed: dryRun.passed,
    },
    incidentLedger: {
      root: sha256AutonomyJson(incidents),
      unresolvedCriticalHigh,
    },
    maintainerWorkPower: {
      agentSetRoot: sha256AutonomyJson(maintainerRows),
      epoch: Number(epoch),
      units: maintainerUnits.toString(),
    },
  };
}

export function reconcileMaturityReadinessEvidence(evidenceSets) {
  if (!Array.isArray(evidenceSets) || evidenceSets.length < 2) {
    throw new Error("V44_MATURITY_READINESS_TWO_PROVIDERS_REQUIRED");
  }
  const root = sha256AutonomyJson(evidenceSets[0]);
  if (evidenceSets.some((evidence) => sha256AutonomyJson(evidence) !== root)) {
    throw new Error("V44_MATURITY_READINESS_PROVIDER_CONFLICT");
  }
  return { evidence: evidenceSets[0], root, providerCount: evidenceSets.length };
}

export function evaluateReliability({
  policy,
  deployment,
  observations,
  sourceEvidence,
  evidencePipelineCommit,
  attestationEvidence,
  rpcEvidence,
  autonomyV2,
  generatedAt = new Date().toISOString(),
  policySha256,
  deploymentFileSha256,
  observationsFileSha256,
  sourceEvidenceFileSha256,
  trustedActivationPublications = null,
}) {
  const blockers = [];
  const generatedAtMs = Date.parse(generatedAt);
  const declaredStartedAt = Date.parse(observations.startedAt);
  const declaredEndedAt = Date.parse(observations.endedAt);
  const chainStartedAt = rpcEvidence?.earliestObservedTimestamp;
  const chainEndedAt = rpcEvidence?.latestObservedTimestamp;
  const chainStartedBlock = rpcEvidence?.earliestObservedBlock;
  const policyIdentity = autonomyPolicyIdentity(
    policy.autonomyV2,
    evidencePipelineCommit,
    {
      policyAnchorAddress: deployment.contracts.policyAnchor,
      trustedPublications: trustedActivationPublications,
    },
  );
  const observationDays =
    Number.isFinite(chainStartedAt) && Number.isFinite(chainEndedAt)
      ? (chainEndedAt - chainStartedAt) / DAY_MS
      : 0;
  const evidenceAgeHours = Number.isFinite(chainEndedAt)
    ? (generatedAtMs - chainEndedAt) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  const categoryCounts = Object.fromEntries(
    Object.keys(policy.categories).map((category) => [category, 0]),
  );
  for (const entry of observations.observations) {
    categoryCounts[entry.category] += 1;
  }
  const openCriticalIncidents = observations.incidents.filter(
    (incident) =>
      ["CRITICAL", "HIGH"].includes(incident?.severity) &&
      incident?.status !== "RESOLVED",
  );

  blocker(
    blockers,
    sourceEvidence.sourceCommit === deployment.sourceCommit,
    "CONTRACT_SOURCE_COMMIT_MISMATCH",
  );
  blocker(
    blockers,
    observations.evidencePipelineCommit === evidencePipelineCommit,
    "EVIDENCE_PIPELINE_COMMIT_MISMATCH",
  );
  blocker(
    blockers,
    observations.policySha256 === policySha256,
    "OBSERVATION_POLICY_HASH_MISMATCH",
  );
  blocker(
    blockers,
    policyIdentity.activationStatus === "ACTIVE" &&
      observations.policyActivatedAt === policyIdentity.activatedAt &&
      observations.policyActivatedBlock === policyIdentity.activatedBlock &&
      observations.signerSetHash === policyIdentity.signerSetHash &&
      observations.policyActivationSequence ===
        policyIdentity.activationSequence &&
      observations.policyActivationAnchorHash ===
        policyIdentity.activationAnchorHash,
    "AUTONOMY_POLICY_ACTIVATION_REQUIRED",
  );
  blocker(
    blockers,
    Number.isFinite(chainStartedAt) &&
      Number.isSafeInteger(chainStartedBlock) &&
      policyIdentity.activatedAt !== null &&
      policyIdentity.activatedBlock !== null &&
      chainStartedAt >= Date.parse(policyIdentity.activatedAt) &&
      chainStartedBlock >= policyIdentity.activatedBlock,
    "OBSERVATION_PRECEDES_POLICY_ACTIVATION",
  );
  blocker(
    blockers,
    rpcEvidence?.liveRpcVerified === true &&
      rpcEvidence?.providerCount >= 2,
    "LIVE_RPC_VERIFICATION_REQUIRED",
  );
  blocker(
    blockers,
    attestationEvidence?.verified === true &&
      attestationEvidence.meetsIndependence === true,
    "INDEPENDENT_OBSERVER_ATTESTATIONS_INSUFFICIENT",
  );
  blocker(
    blockers,
    autonomyV2?.valid === true && autonomyV2?.status === "VERIFIED",
    `AUTONOMY_V2_${autonomyV2?.status ?? "MISSING"}`,
  );
  blocker(
    blockers,
    observationDays >= policy.minimumObservationDays,
    "OBSERVATION_WINDOW_TOO_SHORT",
  );
  blocker(
    blockers,
    Number.isFinite(chainStartedAt) &&
      Number.isFinite(chainEndedAt) &&
      Math.abs(declaredStartedAt - chainStartedAt) <= HOUR_MS &&
      Math.abs(declaredEndedAt - chainEndedAt) <= HOUR_MS,
    "DECLARED_WINDOW_DOES_NOT_MATCH_CHAIN",
  );
  blocker(
    blockers,
    evidenceAgeHours >= 0 &&
      evidenceAgeHours <= policy.maximumEvidenceAgeHours,
    "OBSERVATION_EVIDENCE_STALE",
  );
  blocker(
    blockers,
    rpcEvidence?.verifiedTransactionCount >=
      policy.minimumVerifiedTransactions,
    "VERIFIED_TRANSACTION_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    (rpcEvidence?.contributingAgents?.length ?? 0) >=
      policy.minimumContributingAgents,
    "CONTRIBUTING_AGENT_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    (rpcEvidence?.contributingOperatorGroups?.length ?? 0) >=
      policy.minimumContributingOperatorGroups,
    "CONTRIBUTING_OPERATOR_GROUP_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    rpcEvidence?.indexerLagBlocks <= policy.maximumIndexerLagBlocks,
    "INDEXER_LAG_TOO_HIGH",
  );
  blocker(
    blockers,
    openCriticalIncidents.length <= policy.maximumOpenCriticalIncidents,
    "UNRESOLVED_CRITICAL_INCIDENTS",
  );
  for (const [category, rule] of Object.entries(policy.categories)) {
    blocker(
      blockers,
      categoryCounts[category] >= rule.minimum,
      `CATEGORY_MINIMUM_NOT_MET:${category}`,
    );
  }

  const eligible = blockers.length === 0;
  return {
    schema: RELIABILITY_SCHEMA,
    release: VERSION,
    contractSourceCommit: sourceEvidence.sourceCommit,
    evidencePipelineCommit,
    targetChainId: TARGET_CHAIN_ID,
    decision: eligible ? "approved" : "blocked",
    observedChainId: TESTNET_CHAIN_ID,
    eligible,
    policySha256,
    deploymentManifestSha256: deployment.manifestSha256,
    deploymentFileSha256,
    observationsFileSha256,
    sourceEvidenceFileSha256,
    liveRpcVerified: rpcEvidence?.liveRpcVerified === true,
    autonomyV2,
    observationWindow: {
      startedAt: observations.startedAt,
      endedAt: observations.endedAt,
      chainStartedAt: Number.isFinite(chainStartedAt)
        ? new Date(chainStartedAt).toISOString()
        : null,
      chainEndedAt: Number.isFinite(chainEndedAt)
        ? new Date(chainEndedAt).toISOString()
        : null,
      days: observationDays,
      evidenceAgeHours,
    },
    counts: {
      verifiedTransactions: rpcEvidence?.verifiedTransactionCount ?? 0,
      contributingAgents: rpcEvidence?.contributingAgents?.length ?? 0,
      contributingOperatorGroups:
        rpcEvidence?.contributingOperatorGroups?.length ?? 0,
      independentObservers: attestationEvidence?.observerCount ?? 0,
      independentObserverGroups:
        attestationEvidence?.observerGroupCount ?? 0,
      openCriticalIncidents: openCriticalIncidents.length,
      categories: categoryCounts,
    },
    chainCursor: {
      latestObservedBlock: rpcEvidence?.latestObservedBlock ?? null,
      latestBlock: rpcEvidence?.latestBlock ?? null,
      indexerLagBlocks: rpcEvidence?.indexerLagBlocks ?? null,
    },
    criticalInvariants: Object.fromEntries(
      policy.criticalInvariants.map((invariant) => [
        invariant,
        openCriticalIncidents.every(
          (incident) => incident?.invariant !== invariant,
        ),
      ]),
    ),
    blockers,
    generatedAt,
  };
}

export function blockedReliabilityReport({
  policyEvidence,
  evidencePipelineCommit = currentGitCommit().toLowerCase(),
  contractSourceCommit = null,
  blockers,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schema: RELIABILITY_SCHEMA,
    release: VERSION,
    contractSourceCommit,
    evidencePipelineCommit,
    targetChainId: TARGET_CHAIN_ID,
    decision: "blocked",
    observedChainId: TESTNET_CHAIN_ID,
    eligible: false,
    policySha256: policyEvidence.policySha256,
    deploymentManifestSha256: null,
    deploymentFileSha256: null,
    observationsFileSha256: null,
    sourceEvidenceFileSha256: null,
    liveRpcVerified: false,
    observationWindow: null,
    counts: null,
    chainCursor: null,
    criticalInvariants: Object.fromEntries(
      policyEvidence.policy.criticalInvariants.map((invariant) => [
        invariant,
        false,
      ]),
    ),
    blockers: [...new Set(blockers)],
    generatedAt,
  };
}

export async function buildReliabilityReport({
  policyPath,
  deploymentPath,
  observationsPath,
  sourceEvidencePath,
  rpcUrl,
  secondaryRpcUrl,
  generatedAt = new Date().toISOString(),
  verificationBlockNumber,
}) {
  const policyEvidence = loadReliabilityPolicy(policyPath);
  const missing = [];
  for (const [label, filePath] of [
    ["V44_TESTNET_DEPLOYMENT_MISSING", deploymentPath],
    ["V44_TESTNET_OBSERVATIONS_MISSING", observationsPath],
    ["V44_SOURCE_EVIDENCE_MISSING", sourceEvidencePath],
  ]) {
    if (!filePath || !fs.existsSync(filePath)) missing.push(label);
  }
  if (!rpcUrl) missing.push("V44_TESTNET_RPC_URL_MISSING");
  if (!secondaryRpcUrl) {
    missing.push("V44_TESTNET_SECONDARY_RPC_URL_MISSING");
  }
  if (missing.length > 0) {
    return blockedReliabilityReport({
      policyEvidence,
      blockers: missing,
      generatedAt,
    });
  }

  assertTrackedTreeClean();
  const rawDeployment = readJson(deploymentPath);
  const verifiedSource = verifyHistoricalContractSourceEvidenceFile(
    sourceEvidencePath,
    rawDeployment,
  );
  const sourceEvidence = verifiedSource.evidence;
  const deployment = validateTestnetDeployment(
    rawDeployment,
    sourceEvidence,
  );
  const evidencePipelineCommit = currentGitCommit().toLowerCase();
  const observations = readJson(observationsPath);
  const trustedAutonomyPolicy = policyEvidence.policy.autonomyV2 ?? {};
  // Deployment-time activation evidence is intentionally external to the
  // tracked source policy. Keeping transaction locators in the source commit
  // would create an impossible commit -> transaction -> commit cycle.
  const resolvedAutonomyPolicy = {
    ...trustedAutonomyPolicy,
    policyActivation:
      observations.policyActivation ?? trustedAutonomyPolicy.policyActivation,
  };
  const resolvedPolicy = {
    ...policyEvidence.policy,
    autonomyV2: resolvedAutonomyPolicy,
  };
  const governanceProviderPolicy =
    resolvedAutonomyPolicy.governanceEventProviderPolicy ?? null;
  const operatorFor = (url) => {
    const origin = new URL(url).origin;
    const provider = governanceProviderPolicy?.providers?.find((candidate) =>
      candidate.allowedOrigins.includes(origin),
    );
    if (!provider) {
      throw new Error("V44_GOVERNANCE_RPC_OPERATOR_NOT_PINNED");
    }
    return provider.operatorId;
  };
  let trustedActivationPublications = null;
  if (
    resolvedAutonomyPolicy.policyActivation?.configurationStatus === "ACTIVE"
  ) {
    const activationSnapshots = await Promise.all([
      collectPolicyActivationPublicationSnapshot({
        rpcUrl,
        deployment,
        activation: resolvedAutonomyPolicy.policyActivation,
        providerOperatorId: operatorFor(rpcUrl),
      }),
      collectPolicyActivationPublicationSnapshot({
        rpcUrl: secondaryRpcUrl,
        deployment,
        activation: resolvedAutonomyPolicy.policyActivation,
        providerOperatorId: operatorFor(secondaryRpcUrl),
      }),
    ]);
    trustedActivationPublications =
      reconcilePolicyActivationPublicationSnapshots({
        providers: activationSnapshots,
        providerOperatorPolicy: governanceProviderPolicy,
      }).publications;
  }
  validateObservations(observations, {
    policy: resolvedPolicy,
    policySha256: policyEvidence.policySha256,
    deployment,
    evidencePipelineCommit,
    trustedActivationPublications,
  });
  const autonomyEvidence =
    observations.autonomyEvidence ?? {
      schema: "agentpool.v44.autonomy-evidence/v1",
      exposureLedger: {
        schema: "agentpool.v44.exposure-ledger/v1",
        maximumSuccessfulSystemSettlements:
          PRE_MATURE_MAXIMUM_SUCCESSFUL_SYSTEM_SETTLEMENTS,
        successfulSystemSettlements: 0,
        maturityAuthorizationId: null,
        maturityAuthorizationConsumed: false,
        slots: {},
        journal: [],
      },
      admissionBundles: [],
      settlementBundles: [],
      governanceEventIds: [],
      governanceEventProviders: [],
      checkpoints: [],
      checkpointPolicy: { authorizedPublicKeys: [], threshold: 2 },
    };
  const attestationEvidence = await verifyObservationAttestations(
    observations,
    resolvedPolicy,
    deployment,
  );
  const governancePolicy =
    resolvedAutonomyPolicy.governanceEventPolicy;
  const resolvedGovernancePolicy = governancePolicy
    ? {
        fromBlock:
          governancePolicy.fromBlock === "deployment.deploymentBlock"
            ? deployment.deploymentBlock
            : governancePolicy.fromBlock,
        contracts: {
          taskMarket: deployment.contracts.taskMarket,
          contributionLedger: deployment.contracts.contributionLedger,
          settlementRouter: deployment.contracts.settlementRouter,
          proofRegistry: deployment.contracts.proofRegistry,
          systemIssueGate: deployment.contracts.systemIssueGate,
          transitionIssueConsensus:
            deployment.contracts.transitionIssueConsensus,
          issueConsensus: deployment.contracts.issueConsensus,
        },
      }
    : null;
  let governanceEventProviders = [];
  let canonicalVerificationBlock = verificationBlockNumber;
  if (
    Number.isSafeInteger(resolvedGovernancePolicy?.fromBlock) &&
    resolvedGovernancePolicy.fromBlock >= 0 &&
    governanceProviderPolicy?.configurationStatus === "ACTIVE"
  ) {
    const primaryGovernance = await collectGovernanceEventSnapshot({
      rpcUrl,
      providerOperatorId: operatorFor(rpcUrl),
      fromBlock: resolvedGovernancePolicy.fromBlock,
      contracts: resolvedGovernancePolicy.contracts,
    });
    const secondaryGovernance = await collectGovernanceEventSnapshot({
      rpcUrl: secondaryRpcUrl,
      providerOperatorId: operatorFor(secondaryRpcUrl),
      fromBlock: resolvedGovernancePolicy.fromBlock,
      contracts: resolvedGovernancePolicy.contracts,
      finalizedBlockNumber: primaryGovernance.finalizedBlockNumber,
    });
    governanceEventProviders = [
      primaryGovernance,
      secondaryGovernance,
    ];
    canonicalVerificationBlock =
      primaryGovernance.finalizedBlockNumber;
  }
  const primaryRpcEvidence = await collectLiveRpcEvidence({
    rpcUrl,
    deployment,
    observations,
    policy: policyEvidence.policy,
    verificationBlockNumber: canonicalVerificationBlock,
  });
  const secondaryRpcEvidence = await collectLiveRpcEvidence({
    rpcUrl: secondaryRpcUrl,
    deployment,
    observations,
    policy: policyEvidence.policy,
    verificationBlockNumber: primaryRpcEvidence.latestBlock,
  });
  const rpcEvidence = reconcileRpcEvidenceSnapshots({
    primaryUrl: rpcUrl,
    secondaryUrl: secondaryRpcUrl,
    primary: primaryRpcEvidence,
    secondary: secondaryRpcEvidence,
  });
  let trustedMaturityProviderSnapshots = null;
  let trustedReadinessEvidence = null;
  let trustedMaturityPublication = null;
  if (autonomyEvidence.maturityAuthorization) {
    const maturityPublicationSnapshots = await Promise.all([
      collectMaturityAuthorizationPublicationSnapshot({
        rpcUrl,
        deployment,
        authorization: autonomyEvidence.maturityAuthorization,
        providerOperatorId: operatorFor(rpcUrl),
      }),
      collectMaturityAuthorizationPublicationSnapshot({
        rpcUrl: secondaryRpcUrl,
        deployment,
        authorization: autonomyEvidence.maturityAuthorization,
        providerOperatorId: operatorFor(secondaryRpcUrl),
      }),
    ]);
    trustedMaturityPublication =
      reconcileMaturityAuthorizationPublicationSnapshots({
        providers: maturityPublicationSnapshots,
        providerOperatorPolicy: governanceProviderPolicy,
      }).publication;
    trustedMaturityProviderSnapshots = await Promise.all([
      collectMaturityProviderSnapshot({
        rpcUrl,
        deployment,
        authorization: autonomyEvidence.maturityAuthorization,
        maturityPolicy: resolvedAutonomyPolicy.maturityAuthorizationPolicy,
      }),
      collectMaturityProviderSnapshot({
        rpcUrl: secondaryRpcUrl,
        deployment,
        authorization: autonomyEvidence.maturityAuthorization,
        maturityPolicy: resolvedAutonomyPolicy.maturityAuthorizationPolicy,
      }),
    ]);
    const readinessEvidenceSets = await Promise.all([
      collectMaturityReadinessEvidence({
        rpcUrl,
        deployment,
        maturityPolicy: resolvedAutonomyPolicy.maturityAuthorizationPolicy,
        observations,
        trustedProviderSnapshot: trustedMaturityProviderSnapshots[0],
      }),
      collectMaturityReadinessEvidence({
        rpcUrl: secondaryRpcUrl,
        deployment,
        maturityPolicy: resolvedAutonomyPolicy.maturityAuthorizationPolicy,
        observations,
        trustedProviderSnapshot: trustedMaturityProviderSnapshots[1],
      }),
    ]);
    trustedReadinessEvidence = reconcileMaturityReadinessEvidence(
      readinessEvidenceSets,
    ).evidence;
  }
  const autonomyV2 = validateAutonomyEvidence(
    {
      ...autonomyEvidence,
      governanceEventProviders,
    },
    {
      controlDomainPolicy:
        resolvedAutonomyPolicy.controlDomainPolicy ?? null,
      checkpointPolicy:
        resolvedAutonomyPolicy.checkpointPolicy ?? null,
      governanceEventPolicy: resolvedGovernancePolicy,
      providerOperatorPolicy: governanceProviderPolicy,
      exposurePolicy: resolvedAutonomyPolicy.exposurePolicy ?? null,
      maturityAuthorizationPolicy: resolvedAutonomyPolicy
        .maturityAuthorizationPolicy
        ? {
            ...resolvedAutonomyPolicy.maturityAuthorizationPolicy,
            expectedSourceCommit: evidencePipelineCommit,
            expectedDeploymentManifestSha256: deployment.manifestSha256,
            trustedProviderSnapshots: trustedMaturityProviderSnapshots,
            trustedReadinessEvidence,
            trustedMaturityPublication,
            providerOperatorPolicy: governanceProviderPolicy,
          }
        : null,
      generatedCodeCommit: sha256AutonomyJson({
        domain: "AGENTPOOL_V44_GENERATED_CODE_BINDING_V1",
        sourceCommit: evidencePipelineCommit,
        deploymentManifestSha256: deployment.manifestSha256,
        configSha256: deployment.configSha256,
      }),
      evaluationTimeMs: Date.now(),
    },
  );
  return evaluateReliability({
    policy: resolvedPolicy,
    deployment,
    observations,
    sourceEvidence,
    evidencePipelineCommit,
    attestationEvidence,
    rpcEvidence,
    autonomyV2,
    generatedAt,
    policySha256: policyEvidence.policySha256,
    deploymentFileSha256: sha256File(deploymentPath),
    observationsFileSha256: sha256File(observationsPath),
    sourceEvidenceFileSha256: verifiedSource.fileSha256,
    trustedActivationPublications,
  });
}

export async function verifyPublicTestnetReliabilityGate({
  gateEvidence,
  env = process.env,
  now = new Date(),
}) {
  const reportPath =
    gateEvidence?.evidencePaths?.publicTestnetReliability;
  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_REPORT_MISSING");
  }
  const report = readJson(reportPath);
  const policyPath = path.join(
    ROOT,
    "mainnet-v44-testnet-reliability-policy.json",
  );
  if (
    env.V44_TESTNET_RELIABILITY_POLICY &&
    path.resolve(env.V44_TESTNET_RELIABILITY_POLICY) !== policyPath
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_POLICY_NOT_CANONICAL");
  }
  const policyEvidence = loadReliabilityPolicy(policyPath);
  const chainEndedAtMs = Date.parse(
    report.observationWindow?.chainEndedAt,
  );
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const gateAgeHours = (nowMs - chainEndedAtMs) / HOUR_MS;
  if (
    !Number.isFinite(chainEndedAtMs) ||
    !Number.isFinite(nowMs) ||
    gateAgeHours < 0 ||
    gateAgeHours > policyEvidence.policy.maximumEvidenceAgeHours
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_STALE");
  }
  const deploymentPath = path.resolve(
    env.V44_TESTNET_DEPLOYMENT_MANIFEST ??
      path.join(ROOT, "deployments", "84532.v44.json"),
  );
  const observationsPath = path.resolve(
    env.V44_TESTNET_OBSERVATIONS ??
      path.join(ROOT, "outputs", "v44-public-testnet-observations.json"),
  );
  const sourceEvidencePath = path.resolve(
    env.V44_TESTNET_CONTRACT_SOURCE_EVIDENCE ??
      path.join(
        ROOT,
        "deployments",
        "84532.v44.source-reproducibility.json",
      ),
  );
  const rpcUrl = env.AGENTPOOL_V44_TESTNET_RPC_URL?.trim();
  const secondaryRpcUrl =
    env.AGENTPOOL_V44_TESTNET_RPC_URL_2?.trim();
  const recomputed = await buildReliabilityReport({
    policyPath,
    deploymentPath,
    observationsPath,
    sourceEvidencePath,
    rpcUrl,
    secondaryRpcUrl,
    generatedAt: report.generatedAt,
    verificationBlockNumber: report.chainCursor?.latestBlock,
  });
  if (
    recomputed.eligible !== true ||
    recomputed.decision !== "approved" ||
    sha256Json(recomputed) !== sha256File(reportPath)
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_RECOMPUTE_MISMATCH");
  }
  const currentClient = createPublicClient({
    chain: {
      id: TESTNET_CHAIN_ID,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
  });
  if ((await currentClient.getChainId()) !== TESTNET_CHAIN_ID) {
    throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
  }
  const currentHead = await currentClient.getBlockNumber();
  const latestObservedBlock = BigInt(
    recomputed.chainCursor.latestObservedBlock,
  );
  if (
    currentHead < latestObservedBlock ||
    currentHead - latestObservedBlock >
      BigInt(policyEvidence.policy.maximumIndexerLagBlocks)
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_INDEXER_STALE");
  }
  return recomputed;
}
