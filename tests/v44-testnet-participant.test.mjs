import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildV44BootstrapDelivery,
  createV44TestWallet,
  jobIdFor,
  loadV44BootstrapPublicEvidence,
  parseV44TestnetManifest,
  payoutRoot,
  readV44PrivateKey,
} from "../scripts/lib/v44-testnet-participant.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(
  ROOT,
  "deployments",
  "84532.v44.mainnet-candidate-25eb57c.json",
);

test("v4.4 participant accepts only the isolated Base Sepolia manifest", () => {
  const { manifest } = parseV44TestnetManifest(MANIFEST_PATH);
  assert.equal(manifest.chainId, 84532);
  assert.equal(manifest.campaignId, "mainnet-candidate-25eb57c");
  assert.equal(manifest.token.premintApool, "0");
  assert.equal(manifest.deployerHasRuntimeAuthority, false);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentpool-v44-profile-"));
  try {
    const unsafe = structuredClone(manifest);
    unsafe.chainId = 8453;
    unsafe.network = "Base";
    const unsafePath = path.join(temporary, "unsafe.json");
    fs.writeFileSync(unsafePath, JSON.stringify(unsafe), "utf8");
    assert.throws(
      () => parseV44TestnetManifest(unsafePath),
      /V44_PARTICIPANT_DEPLOYMENT_MANIFEST_INVALID/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("all 24 public bootstrap specifications reproduce their committed delivery hash", () => {
  const { manifest, manifestPath } = parseV44TestnetManifest(MANIFEST_PATH);
  const publicEvidence = loadV44BootstrapPublicEvidence({
    manifest,
    manifestPath,
  });
  assert.equal(publicEvidence.specifications.objectives.length, 24);
  for (let index = 0; index < 24; index += 1) {
    const result = buildV44BootstrapDelivery({
      manifest,
      publicEvidence,
      objectiveIndex: index,
    });
    assert.match(result.deliveryHash, /^0x[a-f0-9]{64}$/u);
    assert.equal(
      result.commitmentVerification,
      "DERIVED_FROM_PINNED_SOURCE_EVIDENCE",
    );
    assert.equal(result.artifact.sourceCommit, manifest.sourceCommit);
    assert.equal(result.artifact.campaignId, manifest.campaignId);
  }
});

test("device wallet stays local and validates its stored public address", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentpool-v44-wallet-"));
  const walletPath = path.join(temporary, "wallet.json");
  try {
    const created = createV44TestWallet({ walletPath, env: {} });
    assert.match(created.address, /^0x[a-fA-F0-9]{40}$/u);
    const stored = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    assert.equal(stored.address, created.address);
    assert.match(stored.privateKey, /^0x[a-fA-F0-9]{64}$/u);
    assert.equal(readV44PrivateKey({ walletPath, env: {} }), stored.privateKey);
    assert.throws(
      () => createV44TestWallet({ walletPath, env: {} }),
      /V44_PARTICIPANT_WALLET_ALREADY_EXISTS/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("job and payout commitments are deterministic and address-bound", () => {
  const market = "0x7315d5C3aC151798492a4b9FA0CbA179299D25e7";
  const creator = "0x3769780cbcB91542474D804524C4D718FBF10fb2";
  const worker = "0x9dDBaa80C9Ed27717660a14A7394D124EF7aA206";
  const plan = `0x${"11".repeat(32)}`;
  const first = jobIdFor(market, creator, 1n, plan);
  const second = jobIdFor(market, creator, 2n, plan);
  assert.notEqual(first, second);
  assert.equal(first, jobIdFor(market, creator, 1n, plan));
  assert.notEqual(payoutRoot([worker], [4n]), payoutRoot([creator], [4n]));
});
