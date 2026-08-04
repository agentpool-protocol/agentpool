import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { observerKeyId } from "../scripts/lib/v44-autonomy-safety.mjs";
import { finalizePolicyActivation } from "../scripts/finalize-v44-policy-activation.mjs";
import { submitPolicyActivation } from "../scripts/submit-v44-policy-activation.mjs";
import {
  activationTypedDataFromRequest,
  buildPolicyActivationPackage,
  validatePolicyActivationPackage,
  validatePolicyActivationSignatures,
} from "../scripts/lib/v44-policy-activation-workflow.mjs";
import {
  artifact,
  loadAndValidateConfig,
  sha256Json,
} from "../scripts/lib/v44-mainnet.mjs";
import {
  loadReliabilityPolicy,
  resolveCampaignAutonomyPolicy,
} from "../scripts/lib/v44-testnet-reliability.mjs";

const sourceCommit = "a".repeat(40);
const hash = (value) => `0x${value.repeat(64).slice(0, 64)}`;
const address = (value) => `0x${value.repeat(40).slice(0, 40)}`;
const ownerKeys = ["11", "22", "33"].map(
  (value) => `0x${value.repeat(32)}`,
);
const owners = ownerKeys
  .map((key) => privateKeyToAccount(key).address)
  .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));

function signer(index) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  return {
    signerKeyId: observerKeyId(publicKeyPem),
    publicKeyPem,
    controllerDomainId: `signer-controller-${index}`,
    custodyDomainId: `signer-custody-${index}`,
    corroborationEvidenceHash: hash(index.toString(16)),
  };
}

function participants() {
  const maturityAgentBindings = ["7", "8", "9", "a", "b"].map(
    (value, index) => ({
      agent: address(value),
      controllerDomainId: `agent-controller-${index}`,
      custodyDomainId: `agent-custody-${index}`,
      corroborationEvidenceHash: hash((index + 1).toString(16)),
    }),
  );
  return {
    schema: "agentpool.testnet.v44.reliability-participants/v1",
    campaignId: "activation-candidate-1",
    sourceCommit,
    status: "READY_FOR_REVIEW",
    thresholdAuthority: {
      threshold: 2,
      owners: owners.map((owner, index) => ({
        address: owner,
        controllerDomainId: `owner-controller-${index}`,
        custodyDomainId: `owner-custody-${index}`,
        corroborationEvidenceHash: hash((index + 10).toString(16)),
      })),
    },
    observers: ["4", "5", "6"].map((value, index) => ({
      address: address(value),
      operatorGroup: hash(value),
      controllerDomainId: `observer-controller-${index}`,
      custodyDomainId: `observer-custody-${index}`,
      corroborationEvidenceHash: hash((index + 13).toString(16)),
    })),
    governanceRpcProviders: [
      {
        operatorId: "rpc-operator-a",
        allowedOrigins: ["https://rpc-a.example"],
        custodyDomainId: "rpc-custody-a",
        corroborationEvidenceHash: hash("d"),
      },
      {
        operatorId: "rpc-operator-b",
        allowedOrigins: ["https://rpc-b.example"],
        custodyDomainId: "rpc-custody-b",
        corroborationEvidenceHash: hash("e"),
      },
    ],
    signerPolicies: Object.fromEntries(
      ["controlDomain", "checkpoint", "maturity"].map((name, index) => [
        name,
        {
          threshold: 2,
          signers: [signer(index * 2 + 1), signer(index * 2 + 2)],
        },
      ]),
    ),
    maturityAgentBindings,
    maturityReadiness: {
      proposalBondOwner: maturityAgentBindings[0].agent,
    },
  };
}

function deployment(participantManifestSha256) {
  return {
    release: "4.4.0-ownerless-mainnet-candidate",
    chainId: 84532,
    campaignId: "activation-candidate-1",
    sourceCommit,
    manifestSha256: "c".repeat(64),
    reliabilityParticipantsSha256: participantManifestSha256,
    contracts: {
      thresholdAuthority: address("1"),
      policyAnchor: address("2"),
      objectiveVerifier: address("3"),
    },
    thresholdAuthorityOwners: owners,
    thresholdAuthorityThreshold: 2,
    dynamicValidatorRoot: hash("f"),
    bootstrap: {
      validators: ["4", "5", "6"].map((value) => ({
        address: address(value),
        group: hash(value),
      })),
    },
    deployedCodeHashes: {
      thresholdAuthority: keccak256(
        artifact("AgentPoolV44ThresholdAuthority").deployedBytecode,
      ),
    },
  };
}

function activationFixture() {
  const manifest = participants();
  const participantManifestSha256 = sha256Json(manifest);
  const manifestDeployment = deployment(participantManifestSha256);
  const { config } = loadAndValidateConfig();
  const policyEvidence = loadReliabilityPolicy();
  const activationPackage = buildPolicyActivationPackage({
    baseAutonomyPolicy: policyEvidence.policy.autonomyV2,
    participants: manifest,
    participantManifestSha256,
    deployment: manifestDeployment,
    config,
    evidencePipelineCommit: "d".repeat(40),
    operationNonce: 0n,
    deadline: 1_800_003_600,
    nowSeconds: 1_800_000_000,
  });
  return {
    manifest,
    participantManifestSha256,
    deployment: manifestDeployment,
    policyEvidence,
    activationPackage,
  };
}

test("participant policy becomes an anchored EIP-712 activation request", async () => {
  const manifest = participants();
  const participantManifestSha256 = sha256Json(manifest);
  const { config } = loadAndValidateConfig();
  const { policy } = loadReliabilityPolicy();
  const result = buildPolicyActivationPackage({
    baseAutonomyPolicy: policy.autonomyV2,
    participants: manifest,
    participantManifestSha256,
    deployment: deployment(participantManifestSha256),
    config,
    evidencePipelineCommit: "d".repeat(40),
    operationNonce: 0n,
    deadline: 1_800_003_600,
    nowSeconds: 1_800_000_000,
  });

  assert.equal(result.autonomyPolicy.policyActivation.configurationStatus, "ACTIVE");
  assert.equal(
    result.autonomyPolicy.observerIndependencePolicy.bindings.length,
    3,
  );
  assert.equal(
    result.autonomyPolicy.maturityAuthorizationPolicy
      .agentControlDomainBindings.length,
    5,
  );
  assert.equal(result.request.threshold, 2);
  assert.match(result.request.operationDigest, /^0x[0-9a-f]{64}$/u);

  const signer = privateKeyToAccount(ownerKeys[0]);
  const typedData = activationTypedDataFromRequest(result.request);
  const signature = await signer.signTypedData(typedData);
  assert.equal(
    getAddress(await recoverTypedDataAddress({ ...typedData, signature })),
    getAddress(signer.address),
  );
  assert.equal(
    validatePolicyActivationPackage(
      result,
      deployment(participantManifestSha256),
    ).valid,
    true,
  );
  assert.equal(
    resolveCampaignAutonomyPolicy({
      trackedAutonomyPolicy: policy.autonomyV2,
      observations: {
        reliabilityParticipants: result.reliabilityParticipants,
        autonomyPolicy: result.autonomyPolicy,
      },
      deployment: deployment(participantManifestSha256),
    }).policyActivation.anchorHistory[0].anchorHash,
    result.autonomyPolicy.policyActivation.anchorHistory[0].anchorHash,
  );
  const signatures = [];
  for (const key of ownerKeys.slice(0, 2)) {
    const owner = privateKeyToAccount(key);
    signatures.push({
      schema: "agentpool.testnet.v44.policy-activation-signature/v1",
      requestSha256: result.request.requestSha256,
      signer: owner.address,
      signature: await owner.signTypedData(typedData),
    });
  }
  const accepted = await validatePolicyActivationSignatures({
    request: result.request,
    signatures,
  });
  assert.equal(accepted.length, 2);
  assert.deepEqual(
    accepted.map((entry) => entry.signer),
    accepted.map((entry) => entry.signer).sort(),
  );
});

test("activation package rejects a participant manifest not committed by deployment", () => {
  const manifest = participants();
  const participantManifestSha256 = sha256Json(manifest);
  const { config } = loadAndValidateConfig();
  const { policy } = loadReliabilityPolicy();
  assert.throws(
    () =>
      buildPolicyActivationPackage({
        baseAutonomyPolicy: policy.autonomyV2,
        participants: manifest,
        participantManifestSha256,
        deployment: deployment("f".repeat(64)),
        config,
        evidencePipelineCommit: "d".repeat(40),
        operationNonce: 0n,
        deadline: 1_800_003_600,
        nowSeconds: 1_800_000_000,
      }),
    /V44_POLICY_ACTIVATION_IDENTITY_MISMATCH/u,
  );
});

test("an edited activation request invalidates the package", () => {
  const manifest = participants();
  const participantManifestSha256 = sha256Json(manifest);
  const { config } = loadAndValidateConfig();
  const { policy } = loadReliabilityPolicy();
  const result = buildPolicyActivationPackage({
    baseAutonomyPolicy: policy.autonomyV2,
    participants: manifest,
    participantManifestSha256,
    deployment: deployment(participantManifestSha256),
    config,
    evidencePipelineCommit: "d".repeat(40),
    operationNonce: 0n,
    deadline: 1_800_003_600,
    nowSeconds: 1_800_000_000,
  });
  result.request.deadline += 1;
  assert.throws(
    () =>
      validatePolicyActivationPackage(
        result,
        deployment(participantManifestSha256),
      ),
    /V44_POLICY_ACTIVATION_PACKAGE_INVALID/u,
  );
});

test("two reviewed signatures can be relayed without exposing owner keys", async () => {
  const fixture = activationFixture();
  const typedData = activationTypedDataFromRequest(
    fixture.activationPackage.request,
  );
  const signatures = [];
  for (const key of ownerKeys.slice(0, 2)) {
    const owner = privateKeyToAccount(key);
    signatures.push({
      schema: "agentpool.testnet.v44.policy-activation-signature/v1",
      requestSha256: fixture.activationPackage.request.requestSha256,
      signer: owner.address,
      signature: await owner.signTypedData(typedData),
    });
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-policy-submit-"),
  );
  const receiptPath = path.join(temporaryDirectory, "receipt.json");
  const transactionHash = hash("9");
  const publicClient = {
    getChainId: async () => 84532,
    readContract: async ({ functionName }) =>
      functionName === "nonce" ? 0n : `0x${"00".repeat(32)}`,
    getBlock: async () => ({ timestamp: 1_800_000_001n }),
    simulateContract: async (request) => ({ request }),
    waitForTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 123n,
      blockHash: hash("a"),
    }),
  };
  const walletClient = {
    writeContract: async () => transactionHash,
  };
  const result = await submitPolicyActivation({
    context: {
      deployment: fixture.deployment,
    },
    activationPackage: fixture.activationPackage,
    signatures,
    rpcUrl: "https://rpc-a.example",
    relayerPrivateKey: `0x${"44".repeat(32)}`,
    receiptPath,
    publicClient,
    walletClient,
  });
  assert.equal(result.transactionHash, transactionHash);
  assert.equal(result.signers.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath)).finalized, false);
});

test("a finalized two-RPC activation starts an immutable observation ledger", async () => {
  const fixture = activationFixture();
  const anchor = fixture.activationPackage.autonomyPolicy.policyActivation
    .anchorHistory[0];
  const transactionHash = hash("9");
  const eventAbi = artifact("AgentPoolV44PolicyAnchor").abi.find(
    (entry) => entry.type === "event" && entry.name === "PolicyActivationAnchored",
  );
  const log = {
    address: fixture.deployment.contracts.policyAnchor,
    logIndex: 7,
    topics: encodeEventTopics({
      abi: [eventAbi],
      eventName: eventAbi.name,
      args: {
        anchorHash: anchor.anchorHash,
        activationSequence: BigInt(anchor.activationSequence),
        policyConfigurationHash: `0x${anchor.policyConfigurationHash}`,
      },
    }),
    data: encodeAbiParameters(
      eventAbi.inputs.filter((input) => !input.indexed),
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
  const publication = {
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
    transactionHash,
    logIndex: 7,
    blockNumber: 123,
    blockHash: hash("a"),
    blockTimestampMs: 1_800_000_001_000,
    authorityRuntimeCodeHash:
      fixture.deployment.deployedCodeHashes.thresholdAuthority,
    authorityOwners: fixture.deployment.thresholdAuthorityOwners
      .map((owner) => owner.toLowerCase())
      .sort(),
    authorityThreshold: fixture.deployment.thresholdAuthorityThreshold,
  };
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-policy-finalize-"),
  );
  const observationsPath = path.join(temporaryDirectory, "observations.json");
  const context = {
    deployment: fixture.deployment,
    policyEvidence: fixture.policyEvidence,
    evidencePipelineCommit: fixture.activationPackage.evidencePipelineCommit,
    observationsPath,
  };
  const result = await finalizePolicyActivation({
    context,
    activationPackage: fixture.activationPackage,
    receiptEvidence: {
      schema: "agentpool.testnet.v44.policy-activation-receipt/v1",
      packageSha256: fixture.activationPackage.packageSha256,
      requestSha256: fixture.activationPackage.request.requestSha256,
      transactionHash,
    },
    primaryRpcUrl: "https://rpc-a.example",
    secondaryRpcUrl: "https://rpc-b.example",
    observationsPath,
    primaryClient: {
      getTransactionReceipt: async () => ({ status: "success", logs: [log] }),
    },
    collectPublication: async ({ providerOperatorId }) => ({
      providerOperatorId,
      publication,
    }),
    reconcilePublications: () => ({ publications: [publication] }),
  });
  assert.equal(result.reliabilityWindowStarted, true);
  const ledger = JSON.parse(fs.readFileSync(observationsPath));
  assert.equal(ledger.policyActivationSequence, 1);
  assert.equal(ledger.autonomyPolicy.policyActivation.configurationStatus, "ACTIVE");
  assert.equal(ledger.reliabilityParticipants.status, "READY_FOR_REVIEW");
});

test("the browser signer requests only the exact EIP-712 signature", () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), "public", "v44-policy-activation-signer.html"),
    "utf8",
  );
  assert.match(html, /eth_signTypedData_v4/u);
  assert.doesNotMatch(html, /eth_sendTransaction/u);
  assert.doesNotMatch(html, /eth_sendRawTransaction/u);
  assert.doesNotMatch(html, /wallet_requestPermissions/u);
});
