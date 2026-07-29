import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertClosedJobSemantic,
  assertCanonicalCreationInput,
  blockedReliabilityReport,
  DEPLOYMENT_SCHEMA,
  evaluateReliability,
  loadReliabilityPolicy,
  observationAttestationMessage,
  validateObservations,
  validateTestnetDeployment,
  verifyObservationAttestations,
  verifyObservationSemantic,
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
const CONTRACT_TYPES = {
  token: "AgentPoolV44Token",
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
    });
    nonce += 1;
  }
  return entries;
}

function observations(policy, manifest) {
  return {
    schema: "agentpool.testnet.v44.observations/v1",
    observedChainId: 84532,
    release: "4.4.0-ownerless-mainnet-candidate",
    sourceCommit: SOURCE_COMMIT,
    deploymentManifestSha256: manifest.manifestSha256,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-04-01T00:00:00.000Z",
    observations: observationEntries(policy),
    incidents: [],
    attestations: [],
  };
}

function completeEvidence(policy, ledger) {
  return {
    attestationEvidence: {
      verified: true,
      meetsIndependence: true,
      observerCount: 2,
      observerGroupCount: 2,
    },
    rpcEvidence: {
      liveRpcVerified: true,
      verifiedTransactionCount: ledger.observations.length,
      contributingAgents: Array.from({ length: 5 }, (_, index) => `${index}`),
      contributingOperatorGroups: ["a", "b", "c"],
      latestObservedBlock: 100,
      earliestObservedTimestamp: Date.parse(ledger.startedAt),
      latestObservedTimestamp: Date.parse(ledger.endedAt),
      latestBlock: 100,
      indexerLagBlocks: 0,
    },
    generatedAt: "2026-04-01T01:00:00.000Z",
    policySha256: policy.policySha256,
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
    () => validateObservations(ledger, { policy, deployment: manifest }),
    /V44_TESTNET_OBSERVATION_TX_REUSED/u,
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
  assert.match(
    packageJson.scripts["evidence:v4.4:testnet"],
    /--env-file-if-exists=\.env\.v44\.testnet\.local/u,
  );
  assert.match(mainnetEnvironment, /AGENTPOOL_V44_TESTNET_RPC_URL=/u);
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
  const manifest = deployment();
  const ledger = observations(policyEvidence.policy, manifest);
  const report = evaluateReliability({
    policy: policyEvidence.policy,
    deployment: manifest,
    observations: ledger,
    sourceEvidence: SOURCE_EVIDENCE,
    ...completeEvidence(policyEvidence, ledger),
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
  assert.match(recorder, /collectLiveRpcEvidence/);
  assert.match(recorder, /next\.attestations = \[\]/);
  assert.ok(
    recorder.indexOf("await collectLiveRpcEvidence") <
      recorder.lastIndexOf("writeJsonAtomic(context.observationsPath"),
  );
  assert.match(incidentRecorder, /next\.attestations = \[\]/);
  assert.match(attester, /observationAttestationMessage/);
  assert.match(attester, /V44_TESTNET_OBSERVER_PRIVATE_KEY/);
  assert.match(helper, /fs\.renameSync\(temporaryPath, filePath\)/);
  assert.match(setup, /privateKeysCopied: false/);
  assert.match(setup, /Array\.from\(\{ length: 24 \}/);
  assert.doesNotMatch(setup, /DEPLOYER_PRIVATE_KEY=.*join/);
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
    sourceCommit: SOURCE_COMMIT,
    blockers: [
      "V44_TESTNET_DEPLOYMENT_MISSING",
      "V44_TESTNET_OBSERVATIONS_MISSING",
    ],
    generatedAt: "2026-04-01T01:00:00.000Z",
  });
  assert.equal(report.eligible, false);
  assert.equal(report.decision, "blocked");
  assert.equal(
    report.criticalInvariants["bootstrap-work-creates-no-work-power"],
    false,
  );
});
