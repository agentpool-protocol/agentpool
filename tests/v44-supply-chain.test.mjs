import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  evaluateMetadataHead,
  evaluateRecoveryCustody,
  keyId,
  signPayload,
  targetAuthorizationBody,
  verifyAuthorizedTarget,
  verifyRootRotation,
} from "../scripts/lib/v44-supply-chain.mjs";
import { sha256Json } from "../scripts/lib/v44-autonomy-safety.mjs";

function keys(count = 3) {
  return Array.from({ length: count }, () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    return {
      publicKey: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      privateKey: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    };
  });
}

function signatures(payload, pairs, indexes) {
  return indexes.map((index) => ({
    keyId: keyId(pairs[index].publicKey),
    signature: signPayload(payload, pairs[index].privateKey),
  }));
}

function targetFixture() {
  const recovery = keys();
  const release = keys(1);
  const bundle = {
    release: "4.4.1-readonly",
    chainId: 84532,
    files: { runner: sha256Json({ bytes: "runner" }) },
  };
  const target = {
    targetSequence: 7,
    releaseVersion: "4.4.1",
    bundleSha256: sha256Json(bundle),
    deploymentManifestSha256: sha256Json({ deployment: "v44" }),
    executableHashes: bundle.files,
    chainId: 84532,
    contractDeploymentHash: sha256Json({ contracts: "v44" }),
    minimumInstallerVersion: "4.4.0",
    validFrom: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    emergencyReadOnly: false,
  };
  target.recoverySignatures = signatures(
    targetAuthorizationBody(target),
    recovery,
    [0, 1],
  );
  target.releaseSignatures = signatures(
    {
      domain: "AGENTPOOL_V44_RELEASE_BUNDLE_V1",
      targetSequence: target.targetSequence,
      bundleSha256: target.bundleSha256,
    },
    release,
    [0],
  );
  return { recovery, release, bundle, target };
}

test("exact target requires recovery threshold and delegated release signature", () => {
  const fixture = targetFixture();
  const result = verifyAuthorizedTarget({
    target: fixture.target,
    bundle: fixture.bundle,
    recoveryPublicKeys: fixture.recovery.map((pair) => pair.publicKey),
    recoveryThreshold: 2,
    delegatedReleasePublicKeys: fixture.release.map(
      (pair) => pair.publicKey,
    ),
    nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
  });
  assert.equal(result.authorized, true);
});

test("compromised release signer cannot authorize a new or high-version bundle", () => {
  const fixture = targetFixture();
  const malicious = {
    ...fixture.bundle,
    release: "999999",
  };
  assert.throws(
    () =>
      verifyAuthorizedTarget({
        target: fixture.target,
        bundle: malicious,
        recoveryPublicKeys: fixture.recovery.map(
          (pair) => pair.publicKey,
        ),
        recoveryThreshold: 2,
        delegatedReleasePublicKeys: fixture.release.map(
          (pair) => pair.publicKey,
        ),
        nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
      }),
    /V44_TARGET_BUNDLE_HASH_MISMATCH/u,
  );
});

test("target sequence, not product version, controls rollback floor", () => {
  const fixture = targetFixture();
  fixture.target.releaseVersion = "1.0.0-recovery";
  fixture.target.recoverySignatures = signatures(
    targetAuthorizationBody(fixture.target),
    fixture.recovery,
    [0, 1],
  );
  assert.equal(
    verifyAuthorizedTarget({
      target: fixture.target,
      bundle: fixture.bundle,
      recoveryPublicKeys: fixture.recovery.map((pair) => pair.publicKey),
      recoveryThreshold: 2,
      delegatedReleasePublicKeys: fixture.release.map(
        (pair) => pair.publicKey,
      ),
      localMinimumAcceptedTargetSequence: 6,
      nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
    }).targetSequence,
    7,
  );
  assert.throws(
    () =>
      verifyAuthorizedTarget({
        target: fixture.target,
        bundle: fixture.bundle,
        recoveryPublicKeys: fixture.recovery.map(
          (pair) => pair.publicKey,
        ),
        recoveryThreshold: 2,
        delegatedReleasePublicKeys: fixture.release.map(
          (pair) => pair.publicKey,
        ),
        localMinimumAcceptedTargetSequence: 8,
        nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
      }),
    /V44_TARGET_SEQUENCE_ROLLBACK/u,
  );
});

test("root rotation needs old and new threshold cross-signatures", () => {
  const oldKeys = keys();
  const newKeys = keys();
  const previous = {
    body: {
      rootMetadataVersion: 1,
      rootKeySet: oldKeys.map((pair) => pair.publicKey),
      rootThreshold: 2,
      previousRootMetadataHash: `0x${"00".repeat(32)}`,
    },
  };
  const next = {
    rootMetadataVersion: 2,
    previousRootMetadataHash: sha256Json(previous.body),
    rootKeySet: newKeys.map((pair) => pair.publicKey),
    rootThreshold: 2,
  };
  const rotation = {
    rootMetadataVersion: 2,
    previousRootMetadataHash: sha256Json(previous.body),
    body: next,
    oldRootSignatures: signatures(next, oldKeys, [0, 1]),
    newRootSignatures: signatures(next, newKeys, [0, 1]),
  };
  assert.equal(
    verifyRootRotation({ previousRoot: previous, nextRoot: rotation })
      .valid,
    true,
  );
  rotation.newRootSignatures = signatures(next, newKeys, [0]);
  assert.throws(
    () =>
      verifyRootRotation({ previousRoot: previous, nextRoot: rotation }),
    /V44_TRUST_THRESHOLD_NOT_MET/u,
  );
});

test("custody gate rejects 2+1 storage and one controller", () => {
  const twoPlusOne = [
    ["a", "one", "k1"],
    ["a", "two", "k2"],
    ["b", "three", "k3"],
  ].map(([custodyDomain, controllerDomain, privateKeyFingerprint]) => ({
    custodyDomain,
    controllerDomain,
    privateKeyFingerprint,
    controlEvidenceStatus: "VERIFIED",
  }));
  assert.equal(
    evaluateRecoveryCustody({ rootThreshold: 2, rootKeys: twoPlusOne })
      .publicWriteReady,
    false,
  );
  const oneController = ["a", "b", "c"].map(
    (custodyDomain, index) => ({
      custodyDomain,
      controllerDomain: "one",
      privateKeyFingerprint: `k${index}`,
      controlEvidenceStatus: "VERIFIED",
    }),
  );
  assert.equal(
    evaluateRecoveryCustody({
      rootThreshold: 2,
      rootKeys: oneController,
    }).publicWriteReady,
    false,
  );
});

test("metadata head requires pinned anchor, independent fresh providers, and agreement", () => {
  const pinnedAnchor = {
    chainId: 84532,
    address: "0x1111111111111111111111111111111111111111",
    runtimeCodeHash: `0x${"1".repeat(64)}`,
  };
  const nowMs = Date.parse("2026-07-30T00:10:00.000Z");
  const head = {
    chainId: 84532,
    anchorAddress: pinnedAnchor.address,
    anchorRuntimeCodeHash: pinnedAnchor.runtimeCodeHash,
    targetSequence: 2,
    metadataHash: `0x${"2".repeat(64)}`,
    finalizedBlockNumber: 100,
    finalizedBlockHash: `0x${"3".repeat(64)}`,
    latestBlockNumber: 110,
    finalizedTimestampMs: Date.parse("2026-07-30T00:09:00.000Z"),
    metadataTimestampMs: Date.parse("2026-07-30T00:08:00.000Z"),
  };
  const providers = [
    {
      ...head,
      providerIdentity: "provider-a",
      origin: "https://a.example",
    },
    {
      ...head,
      providerIdentity: "provider-b",
      origin: "https://b.example",
    },
  ];
  assert.equal(
    evaluateMetadataHead({ pinnedAnchor, providerHeads: providers, nowMs })
      .writeEligible,
    true,
  );
  providers[1].metadataHash = `0x${"4".repeat(64)}`;
  assert.equal(
    evaluateMetadataHead({ pinnedAnchor, providerHeads: providers, nowMs })
      .reason,
    "METADATA_HEAD_CONFLICT",
  );
});

test("public installer is read-only and refuses write enablement", () => {
  const installer = fs.readFileSync(
    new URL("../runner/Install-AgentPoolV44ReadOnly.ps1", import.meta.url),
    "utf8",
  );
  const bundle = JSON.parse(
    fs.readFileSync(
      new URL(
        "../public/agentpool-v44-readonly-bundle.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.match(installer, /if \(\$EnableWrite\)/u);
  assert.match(installer, /public writes are not ready/u);
  assert.doesNotMatch(installer, /Start-Process/u);
  assert.doesNotMatch(installer, /Register-ScheduledTask/u);
  assert.equal(bundle.mode, "read-only");
  assert.equal(bundle.walletCreated, false);
  assert.equal(bundle.publicWriteReady, false);
});
