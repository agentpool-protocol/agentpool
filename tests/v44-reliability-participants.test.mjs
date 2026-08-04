import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { observerKeyId } from "../scripts/lib/v44-autonomy-safety.mjs";
import {
  inspectReliabilityParticipants,
  reliabilityParticipantTemplate,
  validateReliabilityParticipants,
} from "../scripts/lib/v44-reliability-participants.mjs";
import { participantExpectationsFromEnvironment } from "../scripts/prepare-v44-reliability-participants.mjs";

const hash = (value) => `0x${value.repeat(64).slice(0, 64)}`;
const address = (value) => `0x${value.repeat(40).slice(0, 40)}`;
const sourceCommit = "a".repeat(40);
const owners = [address("1"), address("2"), address("3")];
const validators = [
  { address: address("4"), groupId: hash("4") },
  { address: address("5"), groupId: hash("5") },
  { address: address("6"), groupId: hash("6") },
];
const expected = {
  campaignId: "candidate-independent-1",
  sourceCommit,
  thresholdAuthorityOwners: owners,
  thresholdAuthorityThreshold: 2,
  validators,
};

function signer(index) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  return {
    signerKeyId: observerKeyId(publicKeyPem),
    publicKeyPem,
    controllerDomainId: `controller-${index}`,
    custodyDomainId: `custody-${index}`,
    corroborationEvidenceHash: hash(index.toString(16)),
  };
}

function validManifest() {
  const maturityAgentBindings = ["7", "8", "9", "a", "b"].map(
    (value, index) => ({
      agent: address(value),
      controllerDomainId: `agent-controller-${index}`,
      custodyDomainId: `agent-custody-${index}`,
      corroborationEvidenceHash: hash((index + 1).toString(16)),
    }),
  );
  const signerPolicies = Object.fromEntries(
    ["controlDomain", "checkpoint", "maturity"].map((name, policyIndex) => [
      name,
      {
        threshold: 2,
        signers: [signer(policyIndex * 2 + 1), signer(policyIndex * 2 + 2)],
      },
    ]),
  );
  return {
    schema: "agentpool.testnet.v44.reliability-participants/v1",
    campaignId: expected.campaignId,
    sourceCommit,
    status: "READY_FOR_REVIEW",
    thresholdAuthority: {
      threshold: 2,
      owners: owners.map((owner, index) => ({
        address: owner,
        controllerDomainId: `authority-controller-${index}`,
        custodyDomainId: `authority-custody-${index}`,
        corroborationEvidenceHash: hash((index + 7).toString(16)),
      })),
    },
    observers: validators.map((validator, index) => ({
      address: validator.address,
      operatorGroup: validator.groupId,
      controllerDomainId: `observer-controller-${index}`,
      custodyDomainId: `observer-custody-${index}`,
      corroborationEvidenceHash: hash((index + 10).toString(16)),
    })),
    governanceRpcProviders: [
      {
        operatorId: "base-official",
        allowedOrigins: ["https://sepolia.base.org"],
        custodyDomainId: "rpc-custody-base",
        corroborationEvidenceHash: hash("d"),
      },
      {
        operatorId: "publicnode-independent",
        allowedOrigins: ["https://base-sepolia-rpc.publicnode.com"],
        custodyDomainId: "rpc-custody-publicnode",
        corroborationEvidenceHash: hash("e"),
      },
    ],
    signerPolicies,
    maturityAgentBindings,
    maturityReadiness: {
      proposalBondOwner: maturityAgentBindings[0].agent,
    },
  };
}

test("a complete participant manifest binds independent campaign roles", () => {
  const manifest = validManifest();
  const result = validateReliabilityParticipants(manifest, expected);
  assert.equal(result.ready, true);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);
});

test("three wallets controlled by one operator cannot activate reliability", () => {
  const manifest = validManifest();
  for (const owner of manifest.thresholdAuthority.owners) {
    owner.controllerDomainId = "same-person";
  }
  const result = inspectReliabilityParticipants(manifest, expected);
  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.includes(
      "V44_PARTICIPANTS_AUTHORITY_CONTROLLERS_NOT_INDEPENDENT",
    ),
  );
});

test("participant templates contain public placeholders and never private keys", () => {
  const template = reliabilityParticipantTemplate(expected);
  assert.equal(template.status, "INCOMPLETE_DO_NOT_ACTIVATE");
  assert.deepEqual(
    template.thresholdAuthority.owners.map((entry) => entry.address),
    owners,
  );
  assert.equal(JSON.stringify(template).toLowerCase().includes("privatekey"), false);
  assert.equal(inspectReliabilityParticipants(template, expected).ready, false);
});

test("reliability preflight requires the reviewed participant manifest", () => {
  const root = process.cwd();
  const preflight = fs.readFileSync(
    path.join(root, "scripts/preflight-v44-base-mainnet.mjs"),
    "utf8",
  );
  const deployer = fs.readFileSync(
    path.join(root, "scripts/deploy-v44-base-mainnet.mjs"),
    "utf8",
  );
  const verifier = fs.readFileSync(
    path.join(root, "scripts/verify-v44-base-mainnet.mjs"),
    "utf8",
  );
  const example = fs.readFileSync(
    path.join(root, ".env.v44.testnet.example"),
    "utf8",
  );
  assert.match(preflight, /V44_RELIABILITY_PARTICIPANTS_FILE/u);
  assert.match(preflight, /validateReliabilityParticipants/u);
  assert.match(deployer, /validateReliabilityParticipants/u);
  assert.match(deployer, /reliabilityParticipantsSha256/u);
  assert.match(verifier, /validateReliabilityParticipants/u);
  assert.match(verifier, /manifest\.reliabilityParticipantsSha256/u);
  assert.match(
    preflight,
    /bootstrapSpecificationEvidence\.mode === "reliability"/u,
  );
  assert.match(example, /V44_RELIABILITY_PARTICIPANTS_FILE=/u);
});

test("a participant template can be prepared before the new graph exists", () => {
  const env = {
    V44_TESTNET_CAMPAIGN_ID: expected.campaignId,
    V44_SOURCE_COMMIT: sourceCommit,
    V44_THRESHOLD_AUTHORITY_OWNERS: owners.join(","),
    V44_THRESHOLD_AUTHORITY_THRESHOLD: "2",
    V44_VALIDATOR_1: validators[0].address,
    V44_VALIDATOR_1_GROUP_ID: validators[0].groupId,
    V44_VALIDATOR_2: validators[1].address,
    V44_VALIDATOR_2_GROUP_ID: validators[1].groupId,
    V44_VALIDATOR_3: validators[2].address,
    V44_VALIDATOR_3_GROUP_ID: validators[2].groupId,
  };
  const resolved = participantExpectationsFromEnvironment(env);
  assert.equal(resolved.campaignId, expected.campaignId);
  assert.equal(resolved.thresholdAuthorityThreshold, 2);
  assert.deepEqual(
    resolved.validators.map((entry) => entry.groupId),
    validators.map((entry) => entry.groupId),
  );
});
