import crypto from "node:crypto";
import { getAddress, isAddress } from "viem";
import { observerKeyId } from "./v44-autonomy-safety.mjs";
import { sha256Json } from "./v44-mainnet.mjs";

export const V44_RELIABILITY_PARTICIPANTS_SCHEMA =
  "agentpool.testnet.v44.reliability-participants/v1";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const CAMPAIGN_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

function uniqueCount(values) {
  return new Set(values).size;
}

function normalizedAddress(value) {
  return isAddress(value ?? "") ? getAddress(value).toLowerCase() : null;
}

function validDomain(value) {
  return typeof value === "string" && value.trim().length >= 3;
}

function validEvidenceHash(value) {
  return HASH_PATTERN.test(value ?? "") && !/^0x0{64}$/u.test(value);
}

function validOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function validateSignerPolicy(policy, label, blockers) {
  const signers = Array.isArray(policy?.signers) ? policy.signers : [];
  const threshold = policy?.threshold;
  if (!Number.isSafeInteger(threshold) || threshold < 2) {
    blockers.push(`V44_PARTICIPANTS_${label}_THRESHOLD_INVALID`);
    return;
  }
  if (signers.length < threshold) {
    blockers.push(`V44_PARTICIPANTS_${label}_SIGNERS_INSUFFICIENT`);
    return;
  }
  const signerIds = [];
  for (const signer of signers) {
    let publicKeyValid = false;
    try {
      const key = crypto.createPublicKey(signer?.publicKeyPem ?? "");
      publicKeyValid = key.asymmetricKeyType === "ed25519";
    } catch {
      publicKeyValid = false;
    }
    const signerKeyId = publicKeyValid
      ? observerKeyId(signer.publicKeyPem)
      : null;
    if (
      !publicKeyValid ||
      signer?.signerKeyId !== signerKeyId ||
      !validDomain(signer?.controllerDomainId) ||
      !validDomain(signer?.custodyDomainId) ||
      !validEvidenceHash(signer?.corroborationEvidenceHash)
    ) {
      blockers.push(`V44_PARTICIPANTS_${label}_SIGNER_INVALID`);
      return;
    }
    signerIds.push(signerKeyId);
  }
  if (uniqueCount(signerIds) !== signers.length) {
    blockers.push(`V44_PARTICIPANTS_${label}_SIGNERS_DUPLICATED`);
  }
  if (
    uniqueCount(signers.map((entry) => entry.controllerDomainId)) < threshold
  ) {
    blockers.push(`V44_PARTICIPANTS_${label}_CONTROLLERS_NOT_INDEPENDENT`);
  }
  if (uniqueCount(signers.map((entry) => entry.custodyDomainId)) < threshold) {
    blockers.push(`V44_PARTICIPANTS_${label}_CUSTODY_NOT_INDEPENDENT`);
  }
}

export function inspectReliabilityParticipants(
  manifest,
  {
    campaignId,
    sourceCommit,
    thresholdAuthorityOwners,
    thresholdAuthorityThreshold,
    validators,
  },
) {
  const blockers = [];
  if (
    manifest?.schema !== V44_RELIABILITY_PARTICIPANTS_SCHEMA ||
    manifest?.campaignId !== campaignId ||
    !CAMPAIGN_PATTERN.test(manifest?.campaignId ?? "") ||
    manifest?.sourceCommit !== sourceCommit ||
    !COMMIT_PATTERN.test(manifest?.sourceCommit ?? "") ||
    manifest?.status !== "READY_FOR_REVIEW"
  ) {
    blockers.push("V44_PARTICIPANTS_IDENTITY_INVALID");
  }

  const authority = manifest?.thresholdAuthority ?? {};
  const ownerBindings = Array.isArray(authority.owners) ? authority.owners : [];
  const expectedOwners = [...thresholdAuthorityOwners]
    .map((address) => normalizedAddress(address))
    .sort();
  const actualOwners = ownerBindings
    .map((entry) => normalizedAddress(entry?.address))
    .sort();
  if (
    authority.threshold !== thresholdAuthorityThreshold ||
    actualOwners.length !== expectedOwners.length ||
    actualOwners.some((address, index) => address !== expectedOwners[index])
  ) {
    blockers.push("V44_PARTICIPANTS_AUTHORITY_SET_MISMATCH");
  }
  if (
    ownerBindings.some(
      (entry) =>
        normalizedAddress(entry?.address) === null ||
        !validDomain(entry?.controllerDomainId) ||
        !validDomain(entry?.custodyDomainId) ||
        !validEvidenceHash(entry?.corroborationEvidenceHash),
    )
  ) {
    blockers.push("V44_PARTICIPANTS_AUTHORITY_BINDING_INVALID");
  }
  if (
    uniqueCount(ownerBindings.map((entry) => entry.controllerDomainId)) <
    thresholdAuthorityThreshold
  ) {
    blockers.push("V44_PARTICIPANTS_AUTHORITY_CONTROLLERS_NOT_INDEPENDENT");
  }
  if (
    uniqueCount(ownerBindings.map((entry) => entry.custodyDomainId)) <
    thresholdAuthorityThreshold
  ) {
    blockers.push("V44_PARTICIPANTS_AUTHORITY_CUSTODY_NOT_INDEPENDENT");
  }

  const expectedValidators = new Map(
    validators.map((entry) => [
      normalizedAddress(entry.address),
      entry.groupId.toLowerCase(),
    ]),
  );
  const observers = Array.isArray(manifest?.observers)
    ? manifest.observers
    : [];
  if (observers.length < 3) {
    blockers.push("V44_PARTICIPANTS_OBSERVERS_INSUFFICIENT");
  }
  if (
    observers.some((entry) => {
      const address = normalizedAddress(entry?.address);
      return (
        address === null ||
        expectedValidators.get(address) !== entry?.operatorGroup?.toLowerCase?.() ||
        !validEvidenceHash(entry?.operatorGroup) ||
        !validDomain(entry?.controllerDomainId) ||
        !validDomain(entry?.custodyDomainId) ||
        !validEvidenceHash(entry?.corroborationEvidenceHash)
      );
    })
  ) {
    blockers.push("V44_PARTICIPANTS_OBSERVER_BINDING_INVALID");
  }
  if (
    uniqueCount(observers.map((entry) => normalizedAddress(entry.address))) !==
      observers.length ||
    uniqueCount(observers.map((entry) => entry.operatorGroup?.toLowerCase?.())) <
      3 ||
    uniqueCount(observers.map((entry) => entry.controllerDomainId)) < 2 ||
    uniqueCount(observers.map((entry) => entry.custodyDomainId)) < 2
  ) {
    blockers.push("V44_PARTICIPANTS_OBSERVERS_NOT_INDEPENDENT");
  }

  const providers = Array.isArray(manifest?.governanceRpcProviders)
    ? manifest.governanceRpcProviders
    : [];
  const providerOrigins = providers.flatMap((entry) => entry.allowedOrigins ?? []);
  if (providers.length < 2) {
    blockers.push("V44_PARTICIPANTS_RPC_PROVIDERS_INSUFFICIENT");
  }
  if (
    providers.some(
      (entry) =>
        !validDomain(entry?.operatorId) ||
        !Array.isArray(entry?.allowedOrigins) ||
        entry.allowedOrigins.length === 0 ||
        entry.allowedOrigins.some((origin) => !validOrigin(origin)) ||
        !validDomain(entry?.custodyDomainId) ||
        !validEvidenceHash(entry?.corroborationEvidenceHash),
    ) ||
    uniqueCount(providers.map((entry) => entry.operatorId)) !== providers.length ||
    uniqueCount(providers.map((entry) => entry.custodyDomainId)) < 2 ||
    uniqueCount(providerOrigins) !== providerOrigins.length
  ) {
    blockers.push("V44_PARTICIPANTS_RPC_PROVIDERS_NOT_INDEPENDENT");
  }

  validateSignerPolicy(
    manifest?.signerPolicies?.controlDomain,
    "CONTROL_DOMAIN",
    blockers,
  );
  validateSignerPolicy(
    manifest?.signerPolicies?.checkpoint,
    "CHECKPOINT",
    blockers,
  );
  validateSignerPolicy(
    manifest?.signerPolicies?.maturity,
    "MATURITY",
    blockers,
  );

  const agents = Array.isArray(manifest?.maturityAgentBindings)
    ? manifest.maturityAgentBindings
    : [];
  if (agents.length < 5) {
    blockers.push("V44_PARTICIPANTS_MATURITY_AGENTS_INSUFFICIENT");
  }
  if (
    agents.some(
      (entry) =>
        normalizedAddress(entry?.agent) === null ||
        !validDomain(entry?.controllerDomainId) ||
        !validDomain(entry?.custodyDomainId) ||
        !validEvidenceHash(entry?.corroborationEvidenceHash),
    ) ||
    uniqueCount(agents.map((entry) => normalizedAddress(entry.agent))) !==
      agents.length ||
    uniqueCount(agents.map((entry) => entry.controllerDomainId)) < 3 ||
    uniqueCount(agents.map((entry) => entry.custodyDomainId)) < 3
  ) {
    blockers.push("V44_PARTICIPANTS_MATURITY_AGENTS_NOT_INDEPENDENT");
  }
  const bondOwner = normalizedAddress(
    manifest?.maturityReadiness?.proposalBondOwner,
  );
  if (
    bondOwner === null ||
    !agents.some(
      (entry) => normalizedAddress(entry?.agent) === bondOwner,
    )
  ) {
    blockers.push("V44_PARTICIPANTS_MATURITY_BOND_OWNER_INVALID");
  }

  return {
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    manifestSha256:
      blockers.length === 0 ? sha256Json(manifest) : null,
  };
}

export function validateReliabilityParticipants(manifest, expected) {
  const result = inspectReliabilityParticipants(manifest, expected);
  if (!result.ready) {
    throw new Error(`V44_RELIABILITY_PARTICIPANTS_NOT_READY:${result.blockers.join(",")}`);
  }
  return result;
}

function activeSignerPolicy(policy) {
  return {
    configurationStatus: "ACTIVE",
    authorizedPublicKeys: policy.signers.map((signer) => signer.publicKeyPem),
    signerBindings: policy.signers.map((signer) => ({
      signerKeyId: signer.signerKeyId,
      controllerDomainId: signer.controllerDomainId,
      custodyDomainId: signer.custodyDomainId,
      corroborationEvidenceHash: signer.corroborationEvidenceHash,
    })),
    threshold: policy.threshold,
  };
}

/// Convert an already validated public participant manifest into the exact
/// dynamic policy fields that are later committed by PolicyAnchor. The
/// projection deliberately excludes policyActivation and maturity readiness
/// values because those depend on the newly deployed campaign addresses.
export function participantPolicyProjection(manifest) {
  return {
    observerIndependencePolicy: {
      configurationStatus: "ACTIVE",
      bindings: manifest.observers.map((observer) => ({
        observer: getAddress(observer.address).toLowerCase(),
        operatorGroup: observer.operatorGroup.toLowerCase(),
        controllerDomainId: observer.controllerDomainId,
        custodyDomainId: observer.custodyDomainId,
        corroborationEvidenceHash: observer.corroborationEvidenceHash,
      })),
    },
    governanceEventProviderPolicy: {
      configurationStatus: "ACTIVE",
      providers: manifest.governanceRpcProviders.map((provider) => ({
        operatorId: provider.operatorId,
        allowedOrigins: [...provider.allowedOrigins],
        custodyDomainId: provider.custodyDomainId,
        corroborationEvidenceHash: provider.corroborationEvidenceHash,
      })),
    },
    controlDomainPolicy: activeSignerPolicy(
      manifest.signerPolicies.controlDomain,
    ),
    checkpointPolicy: activeSignerPolicy(manifest.signerPolicies.checkpoint),
    maturitySignerPolicy: activeSignerPolicy(manifest.signerPolicies.maturity),
    maturityAgentBindings: manifest.maturityAgentBindings.map((binding) => ({
      agent: getAddress(binding.agent).toLowerCase(),
      controllerDomainId: binding.controllerDomainId,
      custodyDomainId: binding.custodyDomainId,
      corroborationEvidenceHash: binding.corroborationEvidenceHash,
    })),
    thresholdAuthorityOwnerBindings: manifest.thresholdAuthority.owners.map(
      (binding) => ({
        owner: getAddress(binding.address).toLowerCase(),
        controllerDomainId: binding.controllerDomainId,
        custodyDomainId: binding.custodyDomainId,
        corroborationEvidenceHash: binding.corroborationEvidenceHash,
      }),
    ),
  };
}

export function validateParticipantPolicyProjection({
  autonomyPolicy,
  participantManifest,
  deployment,
}) {
  const projection = participantPolicyProjection(participantManifest);
  const expectedAuthorityOwners = deployment.thresholdAuthorityOwners
    .map((owner) => getAddress(owner).toLowerCase())
    .sort();
  const actualAuthorityOwners = autonomyPolicy.policyActivation
    .thresholdAuthority.owners.map((owner) => getAddress(owner).toLowerCase())
    .sort();
  for (const [label, actual, expected] of [
    [
      "OBSERVERS",
      autonomyPolicy.observerIndependencePolicy,
      projection.observerIndependencePolicy,
    ],
    [
      "RPC_PROVIDERS",
      autonomyPolicy.governanceEventProviderPolicy,
      projection.governanceEventProviderPolicy,
    ],
    [
      "CONTROL_KEYS",
      autonomyPolicy.controlDomainPolicy,
      projection.controlDomainPolicy,
    ],
    [
      "CHECKPOINT_KEYS",
      autonomyPolicy.checkpointPolicy,
      projection.checkpointPolicy,
    ],
    [
      "MATURITY_KEYS",
      {
        configurationStatus:
          autonomyPolicy.maturityAuthorizationPolicy.configurationStatus,
        authorizedPublicKeys:
          autonomyPolicy.maturityAuthorizationPolicy.authorizedPublicKeys,
        signerBindings:
          autonomyPolicy.maturityAuthorizationPolicy.signerBindings,
        threshold: autonomyPolicy.maturityAuthorizationPolicy.threshold,
      },
      projection.maturitySignerPolicy,
    ],
    [
      "MATURITY_AGENTS",
      autonomyPolicy.maturityAuthorizationPolicy.agentControlDomainBindings,
      projection.maturityAgentBindings,
    ],
    [
      "AUTHORITY_BINDINGS",
      autonomyPolicy.policyActivation.thresholdAuthority.ownerBindings,
      projection.thresholdAuthorityOwnerBindings,
    ],
  ]) {
    if (sha256Json(actual) !== sha256Json(expected)) {
      throw new Error(`V44_CAMPAIGN_POLICY_${label}_MISMATCH`);
    }
  }
  if (
    autonomyPolicy.policyActivation.thresholdAuthority.address.toLowerCase() !==
      deployment.contracts.thresholdAuthority.toLowerCase() ||
    autonomyPolicy.policyActivation.thresholdAuthority.threshold !==
      deployment.thresholdAuthorityThreshold ||
    sha256Json(actualAuthorityOwners) !== sha256Json(expectedAuthorityOwners)
  ) {
    throw new Error("V44_CAMPAIGN_POLICY_AUTHORITY_MISMATCH");
  }
  return projection;
}

export function reliabilityParticipantTemplate({
  campaignId,
  sourceCommit,
  thresholdAuthorityOwners,
  thresholdAuthorityThreshold,
  validators,
}) {
  const unfilled = (address = null) => ({
    ...(address === null ? {} : { address }),
    controllerDomainId: null,
    custodyDomainId: null,
    corroborationEvidenceHash: null,
  });
  return {
    schema: V44_RELIABILITY_PARTICIPANTS_SCHEMA,
    campaignId,
    sourceCommit,
    status: "INCOMPLETE_DO_NOT_ACTIVATE",
    thresholdAuthority: {
      threshold: thresholdAuthorityThreshold,
      owners: thresholdAuthorityOwners.map((address) => unfilled(address)),
    },
    observers: validators.map((entry) => ({
      ...unfilled(entry.address),
      operatorGroup: entry.groupId,
    })),
    governanceRpcProviders: [],
    signerPolicies: {
      controlDomain: { threshold: 2, signers: [] },
      checkpoint: { threshold: 2, signers: [] },
      maturity: { threshold: 2, signers: [] },
    },
    maturityAgentBindings: [],
    maturityReadiness: {
      proposalBondOwner: null,
    },
  };
}
