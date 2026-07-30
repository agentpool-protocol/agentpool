import crypto from "node:crypto";
import { canonicalJson, sha256Json } from "./v44-autonomy-safety.mjs";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/u;

export function keyId(publicKeyPem) {
  return sha256Json({ publicKeyPem });
}

export function signPayload(payload, privateKeyPem) {
  return crypto
    .sign(
      null,
      Buffer.from(canonicalJson(payload)),
      crypto.createPrivateKey(privateKeyPem),
    )
    .toString("base64");
}

export function verifyThresholdSignatures({
  payload,
  signatures,
  authorizedKeys,
  threshold,
}) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error("V44_TRUST_THRESHOLD_INVALID");
  }
  const keys = new Map(
    authorizedKeys.map((publicKeyPem) => [keyId(publicKeyPem), publicKeyPem]),
  );
  const accepted = new Set();
  for (const entry of signatures ?? []) {
    const publicKeyPem = keys.get(entry.keyId);
    if (!publicKeyPem || accepted.has(entry.keyId)) continue;
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalJson(payload)),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(entry.signature, "base64"),
    );
    if (valid) accepted.add(entry.keyId);
  }
  if (accepted.size < threshold) {
    throw new Error("V44_TRUST_THRESHOLD_NOT_MET");
  }
  return { valid: true, signerKeyIds: [...accepted].sort() };
}

export function targetAuthorizationBody(target) {
  return {
    domain: "AGENTPOOL_V44_TARGET_V1",
    targetSequence: target.targetSequence,
    releaseVersion: target.releaseVersion,
    bundleSha256: target.bundleSha256,
    deploymentManifestSha256: target.deploymentManifestSha256,
    executableHashes: target.executableHashes,
    chainId: target.chainId,
    contractDeploymentHash: target.contractDeploymentHash,
    minimumInstallerVersion: target.minimumInstallerVersion,
    validFrom: target.validFrom,
    expiresAt: target.expiresAt,
    emergencyReadOnly: target.emergencyReadOnly,
  };
}

export function verifyAuthorizedTarget({
  target,
  bundle,
  recoveryPublicKeys,
  recoveryThreshold,
  delegatedReleasePublicKeys,
  localMinimumAcceptedTargetSequence = 0,
  nowMs = Date.now(),
}) {
  const body = targetAuthorizationBody(target);
  verifyThresholdSignatures({
    payload: body,
    signatures: target.recoverySignatures,
    authorizedKeys: recoveryPublicKeys,
    threshold: recoveryThreshold,
  });
  if (target.targetSequence < localMinimumAcceptedTargetSequence) {
    throw new Error("V44_TARGET_SEQUENCE_ROLLBACK");
  }
  if (
    nowMs < Date.parse(target.validFrom) ||
    nowMs > Date.parse(target.expiresAt)
  ) {
    throw new Error("V44_TARGET_METADATA_EXPIRED_OR_NOT_ACTIVE");
  }
  const actualBundleHash = sha256Json(bundle);
  if (
    !HASH_PATTERN.test(target.bundleSha256 ?? "") ||
    actualBundleHash !== target.bundleSha256
  ) {
    throw new Error("V44_TARGET_BUNDLE_HASH_MISMATCH");
  }
  verifyThresholdSignatures({
    payload: {
      domain: "AGENTPOOL_V44_RELEASE_BUNDLE_V1",
      targetSequence: target.targetSequence,
      bundleSha256: target.bundleSha256,
    },
    signatures: target.releaseSignatures,
    authorizedKeys: delegatedReleasePublicKeys,
    threshold: 1,
  });
  return {
    authorized: true,
    targetSequence: target.targetSequence,
    emergencyReadOnly: target.emergencyReadOnly === true,
  };
}

export function verifyRootRotation({
  previousRoot,
  nextRoot,
}) {
  if (
    nextRoot.rootMetadataVersion !==
      previousRoot.body.rootMetadataVersion + 1 ||
    nextRoot.previousRootMetadataHash !== sha256Json(previousRoot.body)
  ) {
    throw new Error("V44_ROOT_ROTATION_CHAIN_INVALID");
  }
  verifyThresholdSignatures({
    payload: nextRoot.body,
    signatures: nextRoot.oldRootSignatures,
    authorizedKeys: previousRoot.body.rootKeySet,
    threshold: previousRoot.body.rootThreshold,
  });
  verifyThresholdSignatures({
    payload: nextRoot.body,
    signatures: nextRoot.newRootSignatures,
    authorizedKeys: nextRoot.body.rootKeySet,
    threshold: nextRoot.body.rootThreshold,
  });
  return { valid: true, rootMetadataVersion: nextRoot.rootMetadataVersion };
}

export function evaluateRecoveryCustody({
  rootThreshold,
  rootKeys,
}) {
  if (rootThreshold !== 2 || rootKeys.length !== 3) {
    return { publicWriteReady: false, reason: "ROOT_SHAPE_INVALID" };
  }
  if (
    rootKeys.some(
      (key) =>
        !key.custodyDomain ||
        !key.controllerDomain ||
        key.controlEvidenceStatus !== "VERIFIED",
    )
  ) {
    return {
      publicWriteReady: false,
      reason: "CUSTODY_OR_CONTROLLER_UNVERIFIED",
    };
  }
  const keyFingerprints = new Set(
    rootKeys.map((key) => key.privateKeyFingerprint),
  );
  if (keyFingerprints.size !== rootKeys.length) {
    return { publicWriteReady: false, reason: "PRIVATE_KEY_DUPLICATED" };
  }
  const custodyCounts = new Map();
  const controllerCounts = new Map();
  for (const key of rootKeys) {
    custodyCounts.set(
      key.custodyDomain,
      (custodyCounts.get(key.custodyDomain) ?? 0) + 1,
    );
    controllerCounts.set(
      key.controllerDomain,
      (controllerCounts.get(key.controllerDomain) ?? 0) + 1,
    );
  }
  if (
    Math.max(...custodyCounts.values()) >= rootThreshold ||
    Math.max(...controllerCounts.values()) >= rootThreshold
  ) {
    return {
      publicWriteReady: false,
      reason: "THRESHOLD_DOMAIN_CONCENTRATION",
    };
  }
  if (custodyCounts.size < 3 || controllerCounts.size < 2) {
    return {
      publicWriteReady: false,
      reason: "OPERATIONAL_INDEPENDENCE_INSUFFICIENT",
    };
  }
  return {
    publicWriteReady: true,
    custodyDomains: custodyCounts.size,
    controllerDomains: controllerCounts.size,
  };
}

export function evaluateMetadataHead({
  pinnedAnchor,
  providerHeads,
  nowMs = Date.now(),
  maximumFinalizedAgeMs = 10 * 60 * 1_000,
  maximumMetadataHeadAgeMs = 60 * 60 * 1_000,
  maximumFinalityLagBlocks = 1_200,
}) {
  if (!pinnedAnchor?.address || !pinnedAnchor?.runtimeCodeHash) {
    return { writeEligible: false, reason: "ANCHOR_IDENTITY_NOT_PINNED" };
  }
  if (!Array.isArray(providerHeads) || providerHeads.length < 2) {
    return { writeEligible: false, reason: "TWO_PROVIDERS_REQUIRED" };
  }
  const identities = new Set(providerHeads.map((head) => head.providerIdentity));
  const origins = new Set(providerHeads.map((head) => head.origin));
  if (identities.size < 2 || origins.size < 2) {
    return {
      writeEligible: false,
      reason: "PROVIDER_INDEPENDENCE_UNPROVEN",
    };
  }
  const [first, ...rest] = providerHeads;
  if (
    providerHeads.some(
      (head) =>
        head.chainId !== pinnedAnchor.chainId ||
        head.anchorAddress.toLowerCase() !==
          pinnedAnchor.address.toLowerCase() ||
        head.anchorRuntimeCodeHash !== pinnedAnchor.runtimeCodeHash,
    )
  ) {
    return { writeEligible: false, reason: "ANCHOR_SUBSTITUTION" };
  }
  if (
    rest.some(
      (head) =>
        head.targetSequence !== first.targetSequence ||
        head.metadataHash !== first.metadataHash ||
        head.finalizedBlockHash !== first.finalizedBlockHash,
    )
  ) {
    return { writeEligible: false, reason: "METADATA_HEAD_CONFLICT" };
  }
  if (
    providerHeads.some(
      (head) =>
        nowMs - head.finalizedTimestampMs > maximumFinalizedAgeMs ||
        nowMs - head.metadataTimestampMs > maximumMetadataHeadAgeMs,
    )
  ) {
    return { writeEligible: false, reason: "METADATA_HEAD_STALE" };
  }
  if (
    providerHeads.some(
      (head) =>
        head.latestBlockNumber - head.finalizedBlockNumber >
        maximumFinalityLagBlocks,
    )
  ) {
    return { writeEligible: false, reason: "FINALITY_LAG_EXCEEDED" };
  }
  return {
    writeEligible: true,
    targetSequence: first.targetSequence,
    metadataHash: first.metadataHash,
    finalizedBlockNumber: first.finalizedBlockNumber,
  };
}
