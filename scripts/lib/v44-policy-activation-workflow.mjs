import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  parseEther,
  recoverTypedDataAddress,
  toBytes,
  zeroAddress,
} from "viem";
import {
  activationBindingsRoot,
  activationSignerSetHash,
  autonomyPolicyConfigurationHash,
  autonomySignerSetHash,
  createPolicyActivationAnchor,
  validateAutonomyPolicy,
} from "./v44-testnet-reliability.mjs";
import {
  participantPolicyProjection,
  validateParticipantPolicyProjection,
  validateReliabilityParticipants,
} from "./v44-reliability-participants.mjs";
import { ROOT, sha256Json } from "./v44-mainnet.mjs";

export const V44_POLICY_ACTIVATION_PACKAGE_SCHEMA =
  "agentpool.testnet.v44.policy-activation-package/v1";
export const V44_POLICY_ACTIVATION_REQUEST_SCHEMA =
  "agentpool.testnet.v44.policy-activation-request/v1";

const POLICY_ACTION = keccak256(toBytes("AGENTPOOL_V44_POLICY_ACTIVATION"));
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const ISSUE_TERMS_COMPONENTS = [
  { name: "issueId", type: "bytes32" },
  { name: "bootstrapProposer", type: "address" },
  { name: "specificationHash", type: "bytes32" },
  { name: "verifier", type: "address" },
  { name: "expectedEvidenceHash", type: "bytes32" },
  { name: "objectiveRoot", type: "bytes32" },
  { name: "validatorRoot", type: "bytes32" },
  { name: "candidateBudgetCap", type: "uint128" },
  { name: "totalBudgetCap", type: "uint128" },
  { name: "maxCandidates", type: "uint16" },
  { name: "minimumReveals", type: "uint16" },
  { name: "passScoreBps", type: "uint16" },
  { name: "minimumValidatorGroups", type: "uint16" },
  { name: "funding", type: "uint8" },
  { name: "expiresAt", type: "uint64" },
];

function fileSha256(relativePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest("hex");
}

function issueTermsHash(issueTerms) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "tuple", components: ISSUE_TERMS_COMPONENTS }],
      [issueTerms],
    ),
  );
}

function activationRequestBody(request) {
  const body = structuredClone(request);
  delete body.requestSha256;
  return body;
}

function activationPackageBody(activationPackage) {
  const body = structuredClone(activationPackage);
  delete body.packageSha256;
  return body;
}

export function policyActivationTypedData({
  chainId,
  thresholdAuthority,
  actionHash,
  operationNonce,
  deadline,
}) {
  return {
    domain: {
      name: "AgentPoolV44ThresholdAuthority",
      version: "1",
      chainId,
      verifyingContract: getAddress(thresholdAuthority),
    },
    types: {
      ThresholdOperation: [
        { name: "actionHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "ThresholdOperation",
    message: {
      actionHash,
      nonce: BigInt(operationNonce),
      deadline: BigInt(deadline),
    },
  };
}

export function createPolicyActivationRequest({
  deployment,
  anchor,
  operationNonce,
  deadline,
}) {
  const anchorArgs = [
    BigInt(anchor.activationSequence),
    `0x${anchor.policyConfigurationHash}`,
    `0x${anchor.signerSetHash}`,
    `0x${anchor.activationSignerSetHash}`,
    anchor.activationThreshold,
    `0x${anchor.activationBindingsRoot}`,
    `0x${anchor.evidencePipelineCommit}`,
    anchor.previousAnchorHash,
    anchor.transparencyLogRoot,
  ];
  const actionHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes20" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        POLICY_ACTION,
        getAddress(deployment.contracts.policyAnchor),
        ...anchorArgs,
      ],
    ),
  );
  const typedData = policyActivationTypedData({
    chainId: deployment.chainId,
    thresholdAuthority: deployment.contracts.thresholdAuthority,
    actionHash,
    operationNonce,
    deadline,
  });
  const request = {
    schema: V44_POLICY_ACTIVATION_REQUEST_SCHEMA,
    campaignId: deployment.campaignId,
    chainId: deployment.chainId,
    thresholdAuthority: getAddress(
      deployment.contracts.thresholdAuthority,
    ).toLowerCase(),
    policyAnchor: getAddress(deployment.contracts.policyAnchor).toLowerCase(),
    owners: deployment.thresholdAuthorityOwners.map((owner) =>
      getAddress(owner).toLowerCase(),
    ),
    threshold: deployment.thresholdAuthorityThreshold,
    operationNonce: operationNonce.toString(),
    deadline: Number(deadline),
    actionHash,
    operationDigest: hashTypedData(typedData),
    typedData: {
      ...typedData,
      message: {
        ...typedData.message,
        nonce: typedData.message.nonce.toString(),
        deadline: typedData.message.deadline.toString(),
      },
    },
    executePolicyActivationArgs: [
      getAddress(deployment.contracts.policyAnchor).toLowerCase(),
      ...anchorArgs.map((value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      operationNonce.toString(),
      Number(deadline),
    ],
  };
  return {
    ...request,
    requestSha256: sha256Json(activationRequestBody(request)),
  };
}

export function buildPolicyActivationPackage({
  baseAutonomyPolicy,
  participants,
  participantManifestSha256,
  deployment,
  config,
  evidencePipelineCommit,
  operationNonce,
  deadline,
  nowSeconds,
}) {
  if (
    deployment.chainId !== 84532 ||
    deployment.campaignId !== participants.campaignId ||
    deployment.sourceCommit !== participants.sourceCommit ||
    deployment.reliabilityParticipantsSha256 !== participantManifestSha256 ||
    !SHA256_PATTERN.test(participantManifestSha256 ?? "") ||
    !COMMIT_PATTERN.test(evidencePipelineCommit ?? "")
  ) {
    throw new Error("V44_POLICY_ACTIVATION_IDENTITY_MISMATCH");
  }
  const projection = participantPolicyProjection(participants);
  const issueId = keccak256(
    toBytes(`AGENTPOOL_V44_RECOVERY:${deployment.campaignId}`),
  );
  const issueTerms = {
    issueId,
    bootstrapProposer: zeroAddress,
    specificationHash: keccak256(
      toBytes(`AGENTPOOL_V44_RECOVERY_SPEC:${deployment.campaignId}`),
    ),
    verifier: getAddress(deployment.contracts.objectiveVerifier).toLowerCase(),
    expectedEvidenceHash: keccak256(
      toBytes(`AGENTPOOL_V44_RECOVERY_EVIDENCE:${deployment.campaignId}`),
    ),
    objectiveRoot: keccak256(
      toBytes(`AGENTPOOL_V44_RECOVERY_OBJECTIVE:${deployment.campaignId}`),
    ),
    validatorRoot: deployment.dynamicValidatorRoot,
    candidateBudgetCap: parseEther(
      config.dynamicIssues.candidateBudgetCapApool,
    ).toString(),
    totalBudgetCap: parseEther(
      config.dynamicIssues.candidateBudgetCapApool,
    ).toString(),
    maxCandidates: 1,
    minimumReveals: 3,
    passScoreBps: 8_000,
    minimumValidatorGroups: 3,
    funding: 3,
    expiresAt: nowSeconds + config.dynamicIssues.maxLifetimeSeconds,
  };
  const policy = structuredClone(baseAutonomyPolicy);
  policy.observerIndependencePolicy =
    projection.observerIndependencePolicy;
  policy.governanceEventProviderPolicy =
    projection.governanceEventProviderPolicy;
  policy.controlDomainPolicy = projection.controlDomainPolicy;
  policy.checkpointPolicy = projection.checkpointPolicy;
  policy.maturityAuthorizationPolicy = {
    ...policy.maturityAuthorizationPolicy,
    ...projection.maturitySignerPolicy,
    agentControlDomainBindings: projection.maturityAgentBindings,
    readinessEvidencePolicy: {
      ...policy.maturityAuthorizationPolicy.readinessEvidencePolicy,
      proposalBond: {
        ...policy.maturityAuthorizationPolicy.readinessEvidencePolicy
          .proposalBond,
        owner: getAddress(
          participants.maturityReadiness.proposalBondOwner,
        ).toLowerCase(),
        requiredAmountWei: parseEther(
          config.consensus.proposalBondApool,
        ).toString(),
      },
      recoveryIssue: {
        issueId,
        termsHash: issueTermsHash(issueTerms),
        issueTerms,
      },
      governanceDryRun: {
        ...policy.maturityAuthorizationPolicy.readinessEvidencePolicy
          .governanceDryRun,
        verifierSha256: fileSha256(
          policy.maturityAuthorizationPolicy.readinessEvidencePolicy
            .governanceDryRun.verifierPath,
        ),
      },
      maintainerAgents: [],
    },
  };
  policy.policyActivation = {
    configurationStatus: "ACTIVE",
    contractKey: "policyAnchor",
    thresholdAuthority: {
      address: getAddress(
        deployment.contracts.thresholdAuthority,
      ).toLowerCase(),
      runtimeCodeHash: deployment.deployedCodeHashes.thresholdAuthority,
      owners: deployment.thresholdAuthorityOwners.map((owner) =>
        getAddress(owner).toLowerCase(),
      ),
      threshold: deployment.thresholdAuthorityThreshold,
      ownerBindings: projection.thresholdAuthorityOwnerBindings,
    },
    anchorHistory: [],
    restartObservationWindowOnChange: true,
    rotationPolicy: "NEW_CONTRACT_AND_WINDOW",
  };
  const transparencyLogRoot = `0x${sha256Json({
    schema: "agentpool.testnet.v44.activation-transparency/v1",
    campaignId: deployment.campaignId,
    deploymentManifestSha256: deployment.manifestSha256,
    participantManifestSha256,
    recoveryIssueTermsHash:
      policy.maturityAuthorizationPolicy.readinessEvidencePolicy.recoveryIssue
        .termsHash,
  })}`;
  const anchor = createPolicyActivationAnchor({
    policyAnchorAddress: deployment.contracts.policyAnchor,
    activationAuthority: deployment.contracts.thresholdAuthority,
    policyConfigurationHash: autonomyPolicyConfigurationHash(policy),
    signerSetHash: autonomySignerSetHash(policy),
    activationSignerSetHash: activationSignerSetHash(
      policy.policyActivation,
    ),
    activationThreshold: deployment.thresholdAuthorityThreshold,
    activationBindingsRoot: activationBindingsRoot(
      policy.policyActivation,
    ),
    evidencePipelineCommit,
    activationSequence: 1,
    previousAnchorHash: ZERO_BYTES32,
    transparencyLogRoot,
  });
  policy.policyActivation.anchorHistory = [anchor];
  validateAutonomyPolicy(policy);
  const request = createPolicyActivationRequest({
    deployment,
    anchor,
    operationNonce,
    deadline,
  });
  const body = {
    schema: V44_POLICY_ACTIVATION_PACKAGE_SCHEMA,
    campaignId: deployment.campaignId,
    chainId: deployment.chainId,
    sourceCommit: deployment.sourceCommit,
    evidencePipelineCommit,
    deploymentManifestSha256: deployment.manifestSha256,
    participantManifestSha256,
    reliabilityParticipants: participants,
    autonomyPolicy: policy,
    request,
  };
  return { ...body, packageSha256: sha256Json(body) };
}

export function activationTypedDataFromRequest(request) {
  if (request?.schema !== V44_POLICY_ACTIVATION_REQUEST_SCHEMA) {
    throw new Error("V44_POLICY_ACTIVATION_REQUEST_INVALID");
  }
  return {
    ...request.typedData,
    message: {
      ...request.typedData.message,
      nonce: BigInt(request.typedData.message.nonce),
      deadline: BigInt(request.typedData.message.deadline),
    },
  };
}

export function validatePolicyActivationPackage(
  activationPackage,
  deployment,
) {
  if (
    activationPackage?.schema !== V44_POLICY_ACTIVATION_PACKAGE_SCHEMA ||
    activationPackage.campaignId !== deployment.campaignId ||
    activationPackage.chainId !== deployment.chainId ||
    activationPackage.sourceCommit !== deployment.sourceCommit ||
    activationPackage.deploymentManifestSha256 !== deployment.manifestSha256 ||
    activationPackage.participantManifestSha256 !==
      deployment.reliabilityParticipantsSha256 ||
    activationPackage.packageSha256 !==
      sha256Json(activationPackageBody(activationPackage))
  ) {
    throw new Error("V44_POLICY_ACTIVATION_PACKAGE_INVALID");
  }
  const participantResult = validateReliabilityParticipants(
    activationPackage.reliabilityParticipants,
    {
      campaignId: deployment.campaignId,
      sourceCommit: deployment.sourceCommit,
      thresholdAuthorityOwners: deployment.thresholdAuthorityOwners,
      thresholdAuthorityThreshold: deployment.thresholdAuthorityThreshold,
      validators: deployment.bootstrap.validators.map((validator) => ({
        address: validator.address,
        groupId: validator.group,
      })),
    },
  );
  if (
    participantResult.manifestSha256 !==
    activationPackage.participantManifestSha256
  ) {
    throw new Error("V44_POLICY_ACTIVATION_PARTICIPANTS_MISMATCH");
  }
  validateAutonomyPolicy(activationPackage.autonomyPolicy);
  validateParticipantPolicyProjection({
    autonomyPolicy: activationPackage.autonomyPolicy,
    participantManifest: activationPackage.reliabilityParticipants,
    deployment,
  });
  const anchor = activationPackage.autonomyPolicy.policyActivation.anchorHistory[0];
  if (
    anchor.policyConfigurationHash !==
      autonomyPolicyConfigurationHash(activationPackage.autonomyPolicy) ||
    anchor.signerSetHash !==
      autonomySignerSetHash(activationPackage.autonomyPolicy) ||
    anchor.activationSignerSetHash !==
      activationSignerSetHash(
        activationPackage.autonomyPolicy.policyActivation,
      ) ||
    anchor.activationBindingsRoot !==
      activationBindingsRoot(
        activationPackage.autonomyPolicy.policyActivation,
      )
  ) {
    throw new Error("V44_POLICY_ACTIVATION_ANCHOR_POLICY_MISMATCH");
  }
  const expectedRequest = createPolicyActivationRequest({
    deployment,
    anchor,
    operationNonce: BigInt(activationPackage.request.operationNonce),
    deadline: activationPackage.request.deadline,
  });
  if (
    activationPackage.request.requestSha256 !==
      sha256Json(activationRequestBody(activationPackage.request)) ||
    expectedRequest.requestSha256 !==
      activationPackage.request.requestSha256 ||
    expectedRequest.operationDigest !==
      activationPackage.request.operationDigest
  ) {
    throw new Error("V44_POLICY_ACTIVATION_REQUEST_MISMATCH");
  }
  return {
    valid: true,
    anchor,
    request: activationPackage.request,
  };
}

export async function validatePolicyActivationSignatures({
  request,
  signatures,
}) {
  const typedData = activationTypedDataFromRequest(request);
  const authorizedOwners = new Set(
    request.owners.map((owner) => getAddress(owner).toLowerCase()),
  );
  const accepted = [];
  for (const entry of signatures) {
    if (
      entry?.schema !==
        "agentpool.testnet.v44.policy-activation-signature/v1" ||
      entry.requestSha256 !== request.requestSha256 ||
      !/^0x[0-9a-fA-F]{130}$/u.test(entry.signature ?? "")
    ) {
      throw new Error("V44_POLICY_ACTIVATION_SIGNATURE_INVALID");
    }
    const recovered = getAddress(
      await recoverTypedDataAddress({
        ...typedData,
        signature: entry.signature,
      }),
    ).toLowerCase();
    if (
      recovered !== getAddress(entry.signer).toLowerCase() ||
      !authorizedOwners.has(recovered)
    ) {
      throw new Error("V44_POLICY_ACTIVATION_SIGNER_UNAUTHORIZED");
    }
    accepted.push({ signer: recovered, signature: entry.signature });
  }
  accepted.sort((left, right) => left.signer.localeCompare(right.signer));
  if (
    new Set(accepted.map((entry) => entry.signer)).size !== accepted.length ||
    accepted.length < request.threshold
  ) {
    throw new Error("V44_POLICY_ACTIVATION_SIGNATURE_THRESHOLD_NOT_MET");
  }
  return accepted;
}
