import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { keccak256, toBytes } from "viem";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  V44_REQUIRED_GATES,
  artifact,
  artifactBytecodeEvidence,
  assertManifestEvidenceClaims,
  assertConfigurationProvenance,
  assertDeploymentProvenance,
  assertTransactionMatchesIntent,
  attachTransactionHash,
  beginTransactionIntent,
  buildBootstrapTerms,
  bootstrapIdentitySha256,
  collectReleaseInputs,
  currentGitCommit,
  loadAndValidateConfig,
  loadAndValidateGates,
  redactBootstrapSecrets,
  requireThresholdAuthorityConfig,
  sha256File,
} from "../scripts/lib/v44-mainnet.mjs";
import {
  buildV44ReleaseEvidence,
  verifyV44ReleaseEvidence,
  verifyV44ReleaseEvidenceFile,
} from "../scripts/generate-v44-release-evidence.mjs";
import {
  requiredDeploymentBalance,
  requireProfileEnvironment,
  resolveV44ChainProfile,
  resolveV44TestnetCampaignFiles,
} from "../scripts/lib/v44-chain-profile.mjs";
import {
  appendTestnetObservation,
  resolveLedgerPaths,
} from "../scripts/lib/v44-observation-ledger.mjs";

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("v4.4 observation appends are idempotent only when explicitly requested", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpool-v44-observation-"));
  const observationsPath = path.join(directory, "observations.json");
  const txHash = `0x${"ab".repeat(32)}`;
  fs.writeFileSync(
    observationsPath,
    `${JSON.stringify({ observations: [{ txHash }] })}\n`,
    "utf8",
  );
  const context = {
    observationsPath,
    policyEvidence: {
      policy: {
        categories: {
          BOOTSTRAP_SETTLED: { contractKey: "taskMarket" },
        },
      },
    },
  };
  const reused = await appendTestnetObservation({
    category: "BOOTSTRAP_SETTLED",
    txHash,
    rpcUrl: "https://unused.invalid",
    allowExisting: true,
    context,
    validate: () => {},
  });
  assert.equal(reused.alreadyRecorded, true);
  assert.equal(reused.observationCount, 1);
  await assert.rejects(
    appendTestnetObservation({
      category: "BOOTSTRAP_SETTLED",
      txHash,
      rpcUrl: "https://unused.invalid",
      context,
      validate: () => {},
    }),
    /V44_TESTNET_OBSERVATION_TX_REUSED/u,
  );
});

test("v4.4 out-of-order observations cannot shrink the evidence window", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpool-v44-window-"));
  const observationsPath = path.join(directory, "observations.json");
  fs.writeFileSync(
    observationsPath,
    `${JSON.stringify({
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-03T00:00:00.000Z",
      observations: [],
      attestations: [{ stale: true }],
    })}\n`,
    "utf8",
  );
  const context = {
    observationsPath,
    deployment: {},
    evidencePipelineCommit: "a".repeat(40),
    policyEvidence: {
      policySha256: "b".repeat(64),
      policy: {
        categories: {
          BOOTSTRAP_SETTLED: {
            contractKey: "taskMarket",
            transactionStatus: "success",
          },
        },
      },
    },
  };
  const client = {
    getChainId: async () => 84532,
    getTransactionReceipt: async () => ({ blockNumber: 1n }),
    getBlock: async () => ({ timestamp: 1_754_006_400n }),
  };
  await appendTestnetObservation({
    category: "BOOTSTRAP_SETTLED",
    txHash: `0x${"cd".repeat(32)}`,
    rpcUrl: "https://unused.invalid",
    context,
    client,
    collectEvidence: async () => {},
    validate: () => {},
  });
  const next = JSON.parse(fs.readFileSync(observationsPath, "utf8"));
  assert.equal(next.startedAt, "2025-07-31T23:59:59.999Z");
  assert.equal(next.endedAt, "2026-08-03T00:00:00.000Z");
  assert.deepEqual(next.attestations, []);
});

test("v4.4 bootstrap campaign recovers settled observations from chain logs", () => {
  const campaign = source("scripts/run-v44-testnet-bootstrap-campaign.mjs");
  const recorder = source("scripts/record-v44-testnet-observation.mjs");
  assert.match(campaign, /eventName: "MilestoneSettled"/u);
  assert.match(campaign, /category: "BOOTSTRAP_SETTLED"/u);
  assert.match(campaign, /allowExisting: true/u);
  assert.match(campaign, /syncBootstrapSettlementObservations\(state\)/u);
  assert.match(recorder, /appendTestnetObservation/u);
});

test("v4.4 reliability bootstrap cannot start from a timer alone", () => {
  const campaign = source("scripts/run-v44-testnet-bootstrap-campaign.mjs");
  const worker = source("scripts/run-v44-testnet-autonomous-worker.mjs");
  const helper = source("scripts/lib/v44-observation-ledger.mjs");
  assert.match(campaign, /assertTestnetReliabilityAdmissionReady/u);
  assert.match(campaign, /const writeAction = \["open", "advance", "run"\]/u);
  assert.match(worker, /WAITING_FOR_RELIABILITY_ADMISSION/u);
  for (const requiredStatus of [
    "OBSERVERS",
    "PROVIDERS",
    "ACTIVATION",
    "CONTROL_DOMAINS",
    "CHECKPOINTS",
    "MATURITY",
  ]) {
    assert.match(helper, new RegExp(`\\["${requiredStatus}"`, "u"));
  }
  assert.match(helper, /collectPolicyActivationPublicationSnapshot/u);
  assert.match(helper, /RPC_OPERATORS_NOT_INDEPENDENT/u);
});

test("v4.4 threshold authority config is canonical and rejects one-key control", () => {
  const owners = [
    "0x3000000000000000000000000000000000000000",
    "0x1000000000000000000000000000000000000000",
    "0x2000000000000000000000000000000000000000",
  ];
  const resolved = requireThresholdAuthorityConfig({
    V44_THRESHOLD_AUTHORITY_OWNERS: owners.join(","),
    V44_THRESHOLD_AUTHORITY_THRESHOLD: "2",
  });
  assert.deepEqual(
    resolved.owners.map((owner) => owner.toLowerCase()),
    [...owners].sort().map((owner) => owner.toLowerCase()),
  );
  assert.equal(resolved.threshold, 2);
  assert.throws(
    () =>
      requireThresholdAuthorityConfig({
        V44_THRESHOLD_AUTHORITY_OWNERS: owners.slice(0, 2).join(","),
        V44_THRESHOLD_AUTHORITY_THRESHOLD: "1",
      }),
    /V44_THRESHOLD_AUTHORITY_CONFIG_INVALID/u,
  );
  assert.throws(
    () =>
      requireThresholdAuthorityConfig({
        V44_THRESHOLD_AUTHORITY_OWNERS: [owners[0], owners[0]].join(","),
        V44_THRESHOLD_AUTHORITY_THRESHOLD: "2",
      }),
    /V44_THRESHOLD_AUTHORITY_CONFIG_INVALID/u,
  );
});

function bootstrapObjectiveCatalog(count = 24) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-objectives-"),
  );
  const filePath = path.join(directory, "objectives.json");
  const bytes32 = (value) =>
    `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  const catalog = {
    schema: "agentpool.mainnet.v44.bootstrap-objectives/v1",
    objectives: Array.from({ length: count }, (_, index) => ({
      capabilityHash: bytes32(1_000 + index),
      specificationHash: bytes32(2_000 + index),
      deliveryHash: bytes32(3_000 + index),
      objectiveProofHex: bytes32(4_000 + index),
      capacityUnits: 100,
    })),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return {
    directory,
    filePath,
    sha256: sha256File(filePath),
  };
}

function gateEvidence(name) {
  const sourceCommit = currentGitCommit();
  if (name === "finalSourceReproducibility") {
    return buildV44ReleaseEvidence({ requireClean: false });
  }
  const common = {
    release: VERSION,
    sourceCommit,
    targetChainId: 8453,
    decision: "approved",
  };
  const schemas = {
    independentSecurityReview:
      "agentpool.mainnet.v44.independent-security-review/v1",
    publicTestnetReliability:
      "agentpool.mainnet.v44.public-testnet-reliability/v1",
    validatorIndependence:
      "agentpool.mainnet.v44.validator-independence/v1",
    economicInvariantReview:
      "agentpool.mainnet.v44.economic-invariant-review/v1",
    deployerLegalAssessment:
      "agentpool.mainnet.v44.deployer-legal-assessment/v1",
    nameAndSymbolClearance:
      "agentpool.mainnet.v44.name-symbol-clearance/v1",
  };
  const evidence = { schema: schemas[name], ...common, gate: name };
  if (
    name === "independentSecurityReview" ||
    name === "economicInvariantReview"
  ) {
    evidence.reviewers = ["reviewer-a", "reviewer-b"];
  } else if (name === "publicTestnetReliability") {
    evidence.observedChainId = 84532;
    evidence.eligible = true;
  } else if (name === "validatorIndependence") {
    evidence.validators = ["validator-a", "validator-b", "validator-c"];
  } else if (name === "deployerLegalAssessment") {
    evidence.actualDeployerAddress =
      "0x1000000000000000000000000000000000000001";
    evidence.jurisdictions = ["test-jurisdiction"];
  } else if (name === "nameAndSymbolClearance") {
    evidence.conflictsCleared = true;
  }
  return evidence;
}

test("v4.4 mainnet token has zero premint and only two bounded minters", () => {
  const tokenSource = source("contracts/v44/AgentPoolV44Token.sol");
  assert.match(tokenSource, /ERC20\("AgentPool", "APOOL"\)/);
  assert.match(tokenSource, /1_000_000_000_000 ether/);
  assert.match(tokenSource, /coreEpochVault/);
  assert.match(tokenSource, /evolutionEpochVault/);
  assert.match(tokenSource, /configurationAuthority = address\(0\)/);
  assert.match(tokenSource, /code\.length == 0/);
  assert.doesNotMatch(tokenSource, /_mint\s*\([^)]*constructor/);
  assert.doesNotMatch(tokenSource, /\bowner\b|\badmin\b|delegatecall|upgradeTo/i);

  const abi = artifact("AgentPoolV44Token").abi;
  const functions = abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name);
  assert.equal(functions.filter((name) => name === "mint").length, 1);
  assert.ok(functions.includes("configureMinters"));
  for (const forbidden of [
    "owner",
    "transferOwnership",
    "upgradeTo",
    "pause",
    "withdraw",
  ]) {
    assert.ok(!functions.includes(forbidden));
  }
});

test("v4.4 mainnet config preserves supply and emission conservation", () => {
  const { config, financeInvariantHash } = loadAndValidateConfig();
  assert.equal(config.release, VERSION);
  assert.equal(config.chainId, 8453);
  assert.equal(config.token.premintApool, "0");
  assert.equal(
    BigInt(config.emission.coreLifetimeCapApool) +
      BigInt(config.emission.evolutionLifetimeCapApool),
    BigInt(config.token.maxSupplyApool),
  );
  assert.equal(
    financeInvariantHash,
    keccak256(toBytes(config.invariants.join("|"))),
  );
  assert.equal(config.bootstrap.minimumValidatorGroups, 3);
  assert.equal(config.bootstrap.minimumReveals, 3);
  assert.equal(config.bootstrap.capacityUnits, 100);
  assert.equal(config.bootstrap.minimumObjectives, 24);
  assert.equal(config.bootstrap.maximumObjectives, 32);
});

test("v4.4 participation counters do not stop at 65,535 agents or groups", () => {
  const ledger = source("contracts/v43/AgentPoolV43ContributionLedger.sol");
  const interfaceSource = source(
    "contracts/v43/interfaces/IAgentPoolV435ContributionLedger.sol",
  );
  assert.match(ledger, /uint32 public eligibleAgentCount/);
  assert.match(ledger, /uint32 public eligibleGroupCount/);
  assert.match(
    interfaceSource,
    /eligibleAgentCount\(\) external view returns \(uint32\)/,
  );
  assert.match(
    interfaceSource,
    /eligibleGroupCount\(\) external view returns \(uint32\)/,
  );
});

test("v4.4 validator rounds are capped against median-sort gas exhaustion", () => {
  const registry = source("contracts/v43/AgentPoolV432ProofRegistry.sol");
  const gate = source("contracts/v43/AgentPoolV435SystemIssueGate.sol");
  assert.match(registry, /uint16 public constant MAX_REVEALS = 15/);
  assert.match(registry, /round\.committed >= MAX_REVEALS/);
  assert.match(gate, /uint16 public constant MAX_DYNAMIC_REVEALS = 15/);
  assert.match(
    gate,
    /issue\.minimumReveals > MAX_DYNAMIC_REVEALS/,
  );
});

test("v4.4 epoch emission cannot reserve or settle before genesis", () => {
  const vaultSource = source("contracts/v43/AgentPoolV43EpochVault.sol");
  const rehearsal = source("scripts/rehearse-v44-mainnet-candidate.mjs");
  assert.match(vaultSource, /error EmissionNotStarted\(\)/);
  assert.equal(
    vaultSource.match(
      /if \(block\.timestamp < genesisStart\) revert EmissionNotStarted\(\);/g,
    )?.length,
    2,
  );
  assert.match(rehearsal, /vault\.emissionCannotReserveBeforeGenesis/);
  assert.match(rehearsal, /token\.supplyRemainsZeroBeforeGenesis/);
  assert.match(rehearsal, /const statefulCases = 128/);
  assert.match(rehearsal, /reservationConserved/);
  assert.match(rehearsal, /supplyConserved/);
  assert.match(rehearsal, /lifetimeCapCountsOpenPriorEpochReservations/);
});

test("v4.4 artifacts are present, deployable, and under the EVM size limit", () => {
  const evidence = artifactBytecodeEvidence();
  for (const name of new Set(Object.values(CONTRACT_TYPES))) {
    assert.ok(evidence[name], `${name} evidence missing`);
    assert.ok(evidence[name].runtimeBytes > 0);
    assert.ok(evidence[name].runtimeBytes <= 24_576);
  }
  assert.equal(
    evidence.AgentPoolV44Token.sourceName,
    "contracts/v44/AgentPoolV44Token.sol",
  );
});

test("v4.4 source evidence binds the exact tree, compiler, and bytecode", () => {
  const evidence = buildV44ReleaseEvidence({ requireClean: false });
  assert.match(evidence.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(evidence.sourceTree, /^[0-9a-f]{40}$/);
  assert.match(evidence.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.solcVersion, /^0\.8\.36\+/);
  assert.equal(evidence.compilerSettings.optimizer.runs, 1);
  assert.equal(evidence.compilerSettings.viaIR, true);
  assert.equal(evidence.compilerSettings.evmVersion, "cancun");
  assert.ok(
    evidence.soliditySources.some(
      (entry) => entry.file === "contracts/v44/AgentPoolV44Token.sol",
    ),
  );
  assert.match(
    evidence.artifacts.AgentPoolV44Token.runtimeBytecodeHash,
    /^0x[0-9a-f]{64}$/,
  );
  verifyV44ReleaseEvidence(evidence, { requireClean: false });

  const tampered = structuredClone(evidence);
  tampered.compilerSettings.optimizer.runs = 200;
  assert.throws(
    () => verifyV44ReleaseEvidence(tampered, { requireClean: false }),
    /V44_SOURCE_EVIDENCE_MISMATCH/,
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-source-evidence-"),
  );
  try {
    const filePath = path.join(directory, "source-evidence.json");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    const fileEvidence = verifyV44ReleaseEvidenceFile(filePath, {
      requireClean: false,
    });
    assert.equal(fileEvidence.fileSha256, sha256File(filePath));
    assert.notEqual(fileEvidence.fileSha256, evidence.evidenceSha256);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Solidity compilation canonicalizes source newlines across operating systems", () => {
  const compiler = source("scripts/compile-contracts.mjs");
  assert.match(
    compiler,
    /function canonicalSource\(file\) \{[\s\S]*replace\(\/\\r\\n\?\/gu, "\\n"\)/,
  );
  assert.equal(
    compiler.match(/\{ content: canonicalSource\(file\) \}/g)?.length,
    1,
  );
  assert.equal(
    compiler.match(/\{ contents: canonicalSource\(match\) \}/g)?.length,
    1,
  );
});

test("v4.4 mainnet gates fail closed while evidence is blocked", () => {
  assert.throws(
    () => loadAndValidateGates({}),
    /V44_GATE_BLOCKED:finalSourceReproducibility/,
  );
  const gates = JSON.parse(source("mainnet-v44-gates.json"));
  assert.ok(Object.keys(gates.gates).length >= 6);
  assert.ok(
    Object.values(gates.gates).every(
      (gate) =>
        gate.status === "blocked" &&
        gate.evidenceSha256 === null &&
        gate.evidenceFile === null,
    ),
  );
  assert.deepEqual(Object.keys(gates.gates), [...V44_REQUIRED_GATES]);
});

test("approved mainnet gates stay outside the source commit", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-gates-"),
  );
  const gatesPath = path.join(temporaryDirectory, "approved-gates.json");
  const gates = JSON.parse(source("mainnet-v44-gates.json"));
  const env = { V44_GATES_FILE: gatesPath };
  try {
    for (const [name, gate] of Object.entries(gates.gates)) {
      const evidencePath = path.join(temporaryDirectory, `${name}.json`);
      fs.writeFileSync(
        evidencePath,
        `${JSON.stringify(gateEvidence(name), null, 2)}\n`,
        "utf8",
      );
      const evidenceSha256 = sha256File(evidencePath);
      gate.status = "approved";
      gate.evidenceSha256 = evidenceSha256;
      gate.evidenceFile = path.basename(evidencePath);
      const envName = `V44_GATE_${name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase()}_SHA256`;
      env[envName] = evidenceSha256;
    }
    fs.writeFileSync(gatesPath, JSON.stringify(gates), "utf8");
    const approved = loadAndValidateGates(env);
    assert.equal(approved.gatesPath, gatesPath);
    assert.equal(
      Object.keys(approved.approved).length,
      V44_REQUIRED_GATES.length,
    );
    assert.equal(
      approved.evidencePaths.finalSourceReproducibility,
      path.join(temporaryDirectory, "finalSourceReproducibility.json"),
    );

    env.V44_GATE_FINAL_SOURCE_REPRODUCIBILITY_SHA256 = "ff".repeat(32);
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_EVIDENCE_MISMATCH:finalSourceReproducibility/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("v4.4 mainnet gate set and file evidence cannot be self-declared away", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-gate-regression-"),
  );
  const gatesPath = path.join(temporaryDirectory, "approved-gates.json");
  const gates = JSON.parse(source("mainnet-v44-gates.json"));
  const env = { V44_GATES_FILE: gatesPath };
  try {
    for (const [name, gate] of Object.entries(gates.gates)) {
      const evidencePath = path.join(temporaryDirectory, `${name}.json`);
      fs.writeFileSync(
        evidencePath,
        `${JSON.stringify(gateEvidence(name), null, 2)}\n`,
        "utf8",
      );
      gate.status = "approved";
      gate.evidenceFile = path.basename(evidencePath);
      gate.evidenceSha256 = sha256File(evidencePath);
      const envName = `V44_GATE_${name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase()}_SHA256`;
      env[envName] = gate.evidenceSha256;
    }
    fs.writeFileSync(gatesPath, JSON.stringify(gates), "utf8");
    assert.doesNotThrow(() => loadAndValidateGates(env));

    const reused = structuredClone(gates);
    reused.gates.independentSecurityReview.evidenceFile =
      reused.gates.finalSourceReproducibility.evidenceFile;
    reused.gates.independentSecurityReview.evidenceSha256 =
      reused.gates.finalSourceReproducibility.evidenceSha256;
    env.V44_GATE_INDEPENDENT_SECURITY_REVIEW_SHA256 =
      reused.gates.finalSourceReproducibility.evidenceSha256;
    fs.writeFileSync(gatesPath, JSON.stringify(reused), "utf8");
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_EVIDENCE_PATH_REUSED:independentSecurityReview/,
    );
    env.V44_GATE_INDEPENDENT_SECURITY_REVIEW_SHA256 =
      gates.gates.independentSecurityReview.evidenceSha256;

    const missing = structuredClone(gates);
    delete missing.gates.independentSecurityReview;
    fs.writeFileSync(gatesPath, JSON.stringify(missing), "utf8");
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_SET_INVALID/,
    );

    const invented = structuredClone(gates);
    delete invented.gates.nameAndSymbolClearance;
    invented.gates.inventedApproval = structuredClone(
      gates.gates.nameAndSymbolClearance,
    );
    fs.writeFileSync(gatesPath, JSON.stringify(invented), "utf8");
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_SET_INVALID/,
    );

    const zero = structuredClone(gates);
    zero.gates.finalSourceReproducibility.evidenceSha256 = "0".repeat(64);
    fs.writeFileSync(gatesPath, JSON.stringify(zero), "utf8");
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_BLOCKED:finalSourceReproducibility/,
    );

    fs.writeFileSync(gatesPath, JSON.stringify(gates), "utf8");
    fs.appendFileSync(
      path.join(temporaryDirectory, "finalSourceReproducibility.json"),
      "tampered\n",
      "utf8",
    );
    assert.throws(
      () => loadAndValidateGates(env),
      /V44_GATE_EVIDENCE_CONTENT_MISMATCH:finalSourceReproducibility/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("every production deployment entrypoint live-recomputes testnet reliability", () => {
  const helper = source("scripts/lib/v44-testnet-reliability.mjs");
  assert.match(
    helper,
    /export async function verifyPublicTestnetReliabilityGate/,
  );
  assert.match(helper, /buildReliabilityReport\(/);
  assert.match(helper, /sha256Json\(recomputed\) !== sha256File\(reportPath\)/);
  assert.match(
    helper,
    /verifyHistoricalContractSourceEvidenceFile\(\s*sourceEvidencePath,/,
  );
  assert.match(helper, /const evidencePipelineCommit = currentGitCommit\(\)/);
  assert.match(helper, /assertTrackedTreeClean\(\)/);
  for (const script of [
    "scripts/preflight-v44-base-mainnet.mjs",
    "scripts/deploy-v44-base-mainnet.mjs",
    "scripts/verify-v44-base-mainnet.mjs",
  ]) {
    assert.match(
      source(script),
      /await verifyPublicTestnetReliabilityGate\(\{ gateEvidence \}\)/,
      script,
    );
  }
});

test("v4.4 manifest claims bind gates, source file, bootstrap, and artifacts", () => {
  const releaseInputs = {
    bootstrap: {
      proposer: "0x1000000000000000000000000000000000000001",
      issueId: `0x${"11".repeat(32)}`,
      validators: [
        {
          address: "0x1000000000000000000000000000000000000002",
          group: `0x${"21".repeat(32)}`,
        },
        {
          address: "0x1000000000000000000000000000000000000003",
          group: `0x${"22".repeat(32)}`,
        },
        {
          address: "0x1000000000000000000000000000000000000004",
          group: `0x${"23".repeat(32)}`,
        },
      ],
    },
  };
  const gateEvidence = {
    approved: Object.fromEntries(
      V44_REQUIRED_GATES.map((name) => [name, "a".repeat(64)]),
    ),
  };
  const sourceEvidence = { evidenceSha256: "b".repeat(64) };
  const artifacts = artifactBytecodeEvidence();
  const manifest = {
    approvedGateEvidence: structuredClone(gateEvidence.approved),
    sourceEvidenceFileSha256: "a".repeat(64),
    sourceEvidenceBodySha256: sourceEvidence.evidenceSha256,
    bootstrapIdentitySha256: bootstrapIdentitySha256(releaseInputs),
    artifactBytecode: structuredClone(artifacts),
  };
  assert.equal(
    assertManifestEvidenceClaims({
      manifest,
      gateEvidence,
      sourceEvidence,
      releaseInputs,
      artifacts,
    }),
    true,
  );
  for (const [field, mutate] of [
    [
      "gate",
      (copy) => {
        copy.approvedGateEvidence.independentSecurityReview = "c".repeat(64);
      },
    ],
    [
      "source",
      (copy) => {
        copy.sourceEvidenceBodySha256 = "c".repeat(64);
      },
    ],
    [
      "bootstrap",
      (copy) => {
        copy.bootstrapIdentitySha256 = "c".repeat(64);
      },
    ],
    [
      "artifact",
      (copy) => {
        copy.artifactBytecode.AgentPoolV44Token.runtimeBytes += 1;
      },
    ],
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(
      () =>
        assertManifestEvidenceClaims({
          manifest: copy,
          gateEvidence,
          sourceEvidence,
          releaseInputs,
          artifacts,
        }),
      /V44_MANIFEST_/,
      field,
    );
  }
});

test("v4.4 release inputs reject shared validator groups", () => {
  const commit = currentGitCommit();
  const future = Math.floor(Date.now() / 1_000) + 4 * 86_400;
  const group = `0x${"ab".repeat(32)}`;
  const env = {
    V44_SOURCE_COMMIT: commit,
    V44_GENESIS_TIMESTAMP: String(future),
    V44_BOOTSTRAP_PROPOSER: "0x1000000000000000000000000000000000000001",
    V44_VALIDATOR_1: "0x1000000000000000000000000000000000000002",
    V44_VALIDATOR_2: "0x1000000000000000000000000000000000000003",
    V44_VALIDATOR_3: "0x1000000000000000000000000000000000000004",
    V44_VALIDATOR_1_GROUP_ID: group,
    V44_VALIDATOR_2_GROUP_ID: group,
    V44_VALIDATOR_3_GROUP_ID: `0x${"cd".repeat(32)}`,
    V44_BOOTSTRAP_ISSUE_ID: `0x${"01".repeat(32)}`,
    V44_GENESIS_MODULE_HASH: `0x${"05".repeat(32)}`,
    V44_GENESIS_MANIFEST_HASH: `0x${"06".repeat(32)}`,
  };
  assert.throws(
    () =>
      collectReleaseInputs({
        env,
        deployerAddress: "0x1000000000000000000000000000000000000005",
      }),
    /V44_VALIDATOR_GROUPS_MUST_BE_DISTINCT/,
  );
});

test("v4.4 bootstrap root binds independent addresses, groups, and proof", () => {
  const catalog = bootstrapObjectiveCatalog();
  const commit = currentGitCommit();
  const future = Math.floor(Date.now() / 1_000) + 4 * 86_400;
  const env = {
    V44_SOURCE_COMMIT: commit,
    V44_GENESIS_TIMESTAMP: String(future),
    V44_BOOTSTRAP_PROPOSER: "0x2000000000000000000000000000000000000001",
    V44_VALIDATOR_1: "0x2000000000000000000000000000000000000002",
    V44_VALIDATOR_2: "0x2000000000000000000000000000000000000003",
    V44_VALIDATOR_3: "0x2000000000000000000000000000000000000004",
    V44_VALIDATOR_1_GROUP_ID: `0x${"11".repeat(32)}`,
    V44_VALIDATOR_2_GROUP_ID: `0x${"22".repeat(32)}`,
    V44_VALIDATOR_3_GROUP_ID: `0x${"33".repeat(32)}`,
    V44_BOOTSTRAP_ISSUE_ID: `0x${"41".repeat(32)}`,
    V44_BOOTSTRAP_OBJECTIVES_FILE: catalog.filePath,
    V44_BOOTSTRAP_OBJECTIVES_SHA256: catalog.sha256,
    V44_GENESIS_MODULE_HASH: `0x${"45".repeat(32)}`,
    V44_GENESIS_MANIFEST_HASH: `0x${"46".repeat(32)}`,
  };
  try {
    const releaseInputs = collectReleaseInputs({
      env,
      deployerAddress: "0x2000000000000000000000000000000000000005",
    });
    const { config } = loadAndValidateConfig();
    const terms = buildBootstrapTerms({
      config,
      releaseInputs,
      verifier: "0x2000000000000000000000000000000000000006",
    });
    assert.notEqual(terms.issueRoot, `0x${"00".repeat(32)}`);
    assert.notEqual(terms.validatorRoot, `0x${"00".repeat(32)}`);
    assert.equal(terms.validators.length, 3);
    assert.equal(new Set(terms.validators.map((entry) => entry.group)).size, 3);
    assert.equal(terms.objectives.length, 24);
    assert.equal(new Set(terms.objectives.map((entry) => entry.leaf)).size, 24);
    assert.ok(terms.objectives.every((entry) => entry.proof.length > 0));
    assert.equal(terms.issue.bootstrapProposer, env.V44_BOOTSTRAP_PROPOSER);
    const changedConfig = structuredClone(config);
    changedConfig.bootstrap.minimumReveals += 1;
    const changedTerms = buildBootstrapTerms({
      config: changedConfig,
      releaseInputs,
      verifier: "0x2000000000000000000000000000000000000006",
    });
    assert.notEqual(
      changedTerms.objectiveRoot,
      terms.objectiveRoot,
      "bootstrap Work Power units must be pinned by the objective root",
    );
  } finally {
    fs.rmSync(catalog.directory, { recursive: true, force: true });
  }
});

test("v4.4 bootstrap rejects a catalog that cannot reach transition", () => {
  const catalog = bootstrapObjectiveCatalog(23);
  const env = {
    V44_SOURCE_COMMIT: currentGitCommit(),
    V44_GENESIS_TIMESTAMP: String(
      Math.floor(Date.now() / 1_000) + 4 * 86_400,
    ),
    V44_BOOTSTRAP_PROPOSER: "0x5000000000000000000000000000000000000001",
    V44_VALIDATOR_1: "0x5000000000000000000000000000000000000002",
    V44_VALIDATOR_2: "0x5000000000000000000000000000000000000003",
    V44_VALIDATOR_3: "0x5000000000000000000000000000000000000004",
    V44_VALIDATOR_1_GROUP_ID: `0x${"51".repeat(32)}`,
    V44_VALIDATOR_2_GROUP_ID: `0x${"52".repeat(32)}`,
    V44_VALIDATOR_3_GROUP_ID: `0x${"53".repeat(32)}`,
    V44_BOOTSTRAP_ISSUE_ID: `0x${"54".repeat(32)}`,
    V44_BOOTSTRAP_OBJECTIVES_FILE: catalog.filePath,
    V44_BOOTSTRAP_OBJECTIVES_SHA256: catalog.sha256,
    V44_GENESIS_MODULE_HASH: `0x${"55".repeat(32)}`,
    V44_GENESIS_MANIFEST_HASH: `0x${"56".repeat(32)}`,
  };
  try {
    assert.throws(
      () =>
        collectReleaseInputs({
          env,
          deployerAddress: "0x5000000000000000000000000000000000000005",
        }),
      /V44_BOOTSTRAP_OBJECTIVES_INVALID/,
    );
  } finally {
    fs.rmSync(catalog.directory, { recursive: true, force: true });
  }
});

test("v4.4 public deployment evidence never publishes bootstrap answers", () => {
  const publicEvidence = redactBootstrapSecrets({
    issueRoot: `0x${"11".repeat(32)}`,
    objectives: [
      {
        capabilityHash: `0x${"12".repeat(32)}`,
        specificationHash: `0x${"13".repeat(32)}`,
        deliveryHash: `0x${"14".repeat(32)}`,
        objectiveProof: "0xdeadbeef",
        expectedEvidenceHash: `0x${"15".repeat(32)}`,
        leaf: `0x${"16".repeat(32)}`,
        proof: [`0x${"17".repeat(32)}`],
        capacityUnits: 100,
      },
    ],
  });
  assert.equal(publicEvidence.objectives.length, 1);
  assert.equal("deliveryHash" in publicEvidence.objectives[0], false);
  assert.equal("objectiveProof" in publicEvidence.objectives[0], false);
  assert.equal(
    publicEvidence.objectives[0].expectedEvidenceHash,
    `0x${"15".repeat(32)}`,
  );
  assert.match(
    source("scripts/deploy-v44-base-mainnet.mjs"),
    /bootstrap: redactBootstrapSecrets\(state\.bootstrap\)/,
  );
  assert.match(source(".gitignore"), /deployments\/8453\.v44\.partial\.json/);
  assert.match(source(".gitignore"), /deployments\/84532\.v44\.partial\.json/);
});

test("v4.4 deployment engine defaults to Base mainnet and testnet requires an explicit acknowledgement", () => {
  const deploy = source("scripts/deploy-v44-base-mainnet.mjs");
  const preflight = source("scripts/preflight-v44-base-mainnet.mjs");
  const verify = source("scripts/verify-v44-base-mainnet.mjs");
  const helper = source("scripts/lib/v44-mainnet.mjs");
  const profileHelper = source("scripts/lib/v44-chain-profile.mjs");
  const defaultProfile = resolveV44ChainProfile({});
  assert.equal(defaultProfile.id, "mainnet");
  assert.equal(defaultProfile.chainId, 8453);
  assert.equal(defaultProfile.requireReleaseGates, true);
  assert.throws(
    () => resolveV44ChainProfile({ V44_DEPLOYMENT_PROFILE: "testnet" }),
    /V44_TESTNET_ONLY_ACK_REQUIRED/u,
  );
  const testnetProfile = resolveV44ChainProfile({
    V44_DEPLOYMENT_PROFILE: "testnet",
    V44_TESTNET_ONLY_ACK:
      "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
  });
  assert.equal(testnetProfile.chainId, 84532);
  assert.equal(testnetProfile.requireReleaseGates, false);
  assert.equal(testnetProfile.testnetOnly, true);
  assert.equal(testnetProfile.campaignId, undefined);
  const isolatedCampaignProfile = resolveV44ChainProfile({
    V44_DEPLOYMENT_PROFILE: "testnet",
    V44_TESTNET_ONLY_ACK:
      "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
    V44_TESTNET_CAMPAIGN_ID: "mainnet-candidate-1",
  });
  assert.equal(isolatedCampaignProfile.id, "testnet-mainnet-candidate-1");
  assert.equal(
    path.basename(isolatedCampaignProfile.manifestPath),
    "84532.v44.mainnet-candidate-1.json",
  );
  assert.equal(
    path.basename(isolatedCampaignProfile.historicalSourceEvidencePath),
    "84532.v44.mainnet-candidate-1.source-reproducibility.json",
  );
  const campaignFiles = resolveV44TestnetCampaignFiles({
    V44_TESTNET_CAMPAIGN_ID: "mainnet-candidate-1",
  });
  assert.equal(
    path.basename(campaignFiles.observationsPath),
    "v44-public-testnet-observations.mainnet-candidate-1.json",
  );
  assert.equal(
    path.basename(campaignFiles.reliabilityPath),
    "v44-public-testnet-reliability.mainnet-candidate-1.json",
  );
  const ledgerPaths = resolveLedgerPaths({
    V44_TESTNET_CAMPAIGN_ID: "mainnet-candidate-1",
  });
  assert.equal(ledgerPaths.campaignId, "mainnet-candidate-1");
  assert.equal(ledgerPaths.deploymentPath, campaignFiles.deploymentPath);
  assert.equal(ledgerPaths.observationsPath, campaignFiles.observationsPath);
  assert.equal(
    ledgerPaths.sourceEvidencePath,
    campaignFiles.sourceEvidencePath,
  );
  const overriddenLedgerPaths = resolveLedgerPaths({
    V44_TESTNET_CAMPAIGN_ID: "mainnet-candidate-1",
    V44_TESTNET_OBSERVATIONS: "custom-observations.json",
    V44_SOURCE_EVIDENCE_FILE: "pre-deploy-source.json",
  });
  assert.equal(
    overriddenLedgerPaths.observationsPath,
    path.resolve("custom-observations.json"),
  );
  assert.equal(
    overriddenLedgerPaths.sourceEvidencePath,
    campaignFiles.sourceEvidencePath,
  );
  assert.throws(
    () =>
      resolveV44ChainProfile({
        V44_DEPLOYMENT_PROFILE: "testnet",
        V44_TESTNET_ONLY_ACK:
          "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
        V44_TESTNET_CAMPAIGN_ID: "../overwrite",
      }),
    /V44_TESTNET_CAMPAIGN_ID_INVALID/u,
  );
  assert.equal(
    requireProfileEnvironment(testnetProfile, {
      AGENTPOOL_V44_TESTNET_RPC_URL: "https://sepolia.base.org",
    }).minimumBalance,
    1_000_000_000_000_000n,
  );
  assert.match(profileHelper, /AGENTPOOL_MAINNET_RPC_URL/);
  assert.match(profileHelper, /AGENTPOOL_V44_TESTNET_RPC_URL/);
  assert.doesNotMatch(
    [deploy, preflight, verify].join("\n"),
    /MockRandomness|mock verifier/i,
  );
  assert.match(deploy, /AgentPoolV44Token/);
  assert.match(deploy, /confirmations: 2/);
  assert.match(deploy, /V44_RESIDUAL_AUTHORITY/);
  assert.match(deploy, /schemaVersion: 3/);
  assert.match(deploy, /deploymentTransactions/);
  assert.match(deploy, /configurationTransactions/);
  assert.match(deploy, /transactionIntents/);
  assert.match(deploy, /encodeDeployData/);
  assert.match(deploy, /V44_PARTIAL_DEPLOYMENT_TX_MISSING/);
  assert.match(profileHelper, /V44_MINIMUM_DEPLOYER_BALANCE_INVALID/);
  assert.match(helper, /V44_UNCERTAIN_BROADCAST/);
  assert.match(helper, /V44_GIT_INDEX_FLAGGED/);
  assert.match(helper, /V44_WORKTREE_BLOB_MISMATCH/);
  assert.match(deploy, /blockTag: "pending"/);
  assert.match(verify, /V44_SOURCE_COMMIT_NOT_HEAD/);
  assert.match(verify, /assertTrackedTreeClean\(\)/);
  assert.match(verify, /assertManifestEvidenceClaims/);
  assert.match(verify, /creationTransaction\.currentArtifact/);
  assert.match(verify, /manifest\.transactionSetComplete/);
  assert.match(verify, /manifest\.contractKeysExact/);
  assert.match(
    verify,
    /bootstrapVerifierCodehashMatchesObjectiveVerifier/,
  );
  assert.match(verify, /supplyEqualsEpochEmissions/);
  assert.match(
    source("scripts/reconcile-v44-mainnet-intent.mjs"),
    /state\.schemaVersion !== 3/,
  );
});

test("testnet deployment balance uses RPC-proven historical cost with a safety floor", async () => {
  const profile = resolveV44ChainProfile({
    V44_DEPLOYMENT_PROFILE: "testnet",
    V44_TESTNET_ONLY_ACK:
      "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
    V44_TESTNET_CAMPAIGN_ID: "gas-check",
  });
  let requests = 0;
  const requirement = await requiredDeploymentBalance({
    profile,
    client: {
      async request({ method }) {
        assert.equal(method, "eth_getTransactionReceipt");
        requests += 1;
        return {
          status: "0x1",
          gasUsed: "0x64",
          effectiveGasPrice: "0x0a",
          l1Fee: "0x32",
        };
      },
    },
    operatorFloor: 1n,
  });
  assert.equal(requests, requirement.referenceTransactionCount);
  assert.equal(requirement.referenceCost, BigInt(requests) * 1_050n);
  assert.equal(requirement.safetyMultiplier, 5n);
  assert.equal(requirement.requiredBalance, 500_000_000_000_000n);

  const mainnetRequirement = await requiredDeploymentBalance({
    profile: resolveV44ChainProfile({ V44_DEPLOYMENT_PROFILE: "mainnet" }),
    client: null,
    operatorFloor: 123n,
  });
  assert.equal(mainnetRequirement.requiredBalance, 123n);
});

test("v4.4 deployment resume rejects tampered transaction provenance", () => {
  const expectedFrom = "0x1000000000000000000000000000000000000001";
  const expectedTo = "0x2000000000000000000000000000000000000002";
  const contractAddress = "0x3000000000000000000000000000000000000003";
  const input = "0x60006000";
  const successfulReceipt = {
    status: "success",
    contractAddress,
  };
  const deploymentTransaction = {
    from: expectedFrom,
    to: null,
    input,
  };
  assert.equal(
    assertDeploymentProvenance({
      key: "token",
      expectedFrom,
      expectedInput: input,
      expectedAddress: contractAddress,
      transaction: deploymentTransaction,
      receipt: successfulReceipt,
    }),
    contractAddress,
  );
  assert.throws(
    () =>
      assertDeploymentProvenance({
        key: "token",
        expectedFrom,
        expectedInput: "0x60016000",
        expectedAddress: contractAddress,
        transaction: deploymentTransaction,
        receipt: successfulReceipt,
      }),
    /V44_DEPLOYMENT_INPUT_MISMATCH:token/,
  );
  assert.throws(
    () =>
      assertDeploymentProvenance({
        key: "token",
        expectedFrom,
        expectedInput: input,
        expectedAddress: "0x4000000000000000000000000000000000000004",
        transaction: deploymentTransaction,
        receipt: successfulReceipt,
      }),
    /V44_DEPLOYMENT_ADDRESS_MISMATCH:token/,
  );

  const configurationTransaction = {
    from: expectedFrom,
    to: expectedTo,
    input: "0x12345678",
  };
  assert.doesNotThrow(() =>
    assertConfigurationProvenance({
      key: "market:configure",
      expectedFrom,
      expectedTo,
      expectedInput: configurationTransaction.input,
      transaction: configurationTransaction,
      receipt: { status: "success" },
    }),
  );
  assert.throws(
    () =>
      assertConfigurationProvenance({
        key: "market:configure",
        expectedFrom,
        expectedTo,
        expectedInput: "0x87654321",
        transaction: configurationTransaction,
        receipt: { status: "success" },
      }),
    /V44_CONFIGURATION_INPUT_MISMATCH:market:configure/,
  );
});

test("v4.4 deployment journal fails closed across an uncertain broadcast", () => {
  const intents = {};
  const key = "deploy:token";
  const inputHash = `0x${"11".repeat(32)}`;
  beginTransactionIntent({
    intents,
    key,
    kind: "deployment",
    nonce: 7,
    to: null,
    inputHash,
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  assert.throws(
    () =>
      beginTransactionIntent({
        intents,
        key,
        kind: "deployment",
        nonce: 7,
        to: null,
        inputHash,
      }),
    /V44_UNCERTAIN_BROADCAST:deploy:token/,
  );
  const hash = `0x${"22".repeat(32)}`;
  attachTransactionHash({ intents, key, hash });
  assert.equal(intents[key].hash, hash);
  assert.throws(
    () =>
      attachTransactionHash({
        intents,
        key,
        hash: `0x${"33".repeat(32)}`,
      }),
    /V44_TRANSACTION_HASH_MISMATCH:deploy:token/,
  );

  const transaction = {
    from: "0x1000000000000000000000000000000000000001",
    to: null,
    nonce: 7,
    input: "0x60006000",
  };
  const matchingIntent = {
    nonce: 7,
    to: null,
    inputHash: keccak256(transaction.input),
  };
  assert.equal(
    assertTransactionMatchesIntent({
      key,
      intent: matchingIntent,
      expectedFrom: transaction.from,
      transaction,
    }),
    true,
  );
  assert.throws(
    () =>
      assertTransactionMatchesIntent({
        key,
        intent: matchingIntent,
        expectedFrom: transaction.from,
        transaction: { ...transaction, input: "0x60016000" },
      }),
    /V44_RECONCILE_INPUT_MISMATCH:deploy:token/,
  );
  assert.match(
    source("scripts/reconcile-v44-mainnet-intent.mjs"),
    /assertTransactionMatchesIntent/,
  );
});

test("v4.4 invalid proof cannot be used to slash another worker", () => {
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  const invalidProofGuard = market.indexOf(
    "if (!passed) revert VerificationFailed();",
  );
  const resolutionRead = market.indexOf(
    "uint8 proofStatus = proofRegistryV2.resolutionStatus(",
  );
  const noQuorumRefund = market.indexOf("if (proofStatus == 1)");
  const acceptedStatus = market.indexOf("passed = proofStatus == 3");
  const rejectionBranch = market.indexOf("if (!passed) {", acceptedStatus);
  assert.ok(invalidProofGuard > 0);
  assert.ok(resolutionRead > invalidProofGuard);
  assert.ok(noQuorumRefund > resolutionRead);
  assert.ok(acceptedStatus > noQuorumRefund);
  assert.ok(rejectionBranch > acceptedStatus);
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /caller-selected invalid proof cannot reject a delivered milestone/,
  );
});

test("v4.4 system issue policy cannot advertise one verifier set and use another", () => {
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  for (const guard of [
    /term\.verifier != issue\.verifier/,
    /term\.minimumReveals != issue\.minimumReveals/,
    /term\.passScoreBps != issue\.passScoreBps/,
    /policy\.validatorRoot != issue\.validatorRoot/,
    /policy\.minimumOperatorGroups !=\s*issue\.minimumValidatorGroups/,
  ]) {
    assert.match(market, guard);
  }
  assert.match(
    market,
    /Replanning creates a new continuation job/,
  );
  assert.match(
    market,
    /function replanRemainingV2\([\s\S]*?revert Unauthorized\(\);/,
  );
});

test("v4.4 release candidates are bound to the verified delivery", () => {
  const market = source("contracts/v43/AgentPoolV43TaskMarket.sol");
  assert.match(
    market,
    /milestone\.deliveryHash != keccak256\(\s*abi\.encode\(\s*"AGENTPOOL_CANDIDATE_ARTIFACT",\s*moduleHash,\s*manifestHash,\s*canaryHash/,
  );
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /a settled improvement cannot attest an unrelated release artifact/,
  );
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /a settled improvement cannot attach unverified canary metrics/,
  );
});

test("v4.4 adoption proves use of the proposed release", () => {
  const market = source("contracts/v43/AgentPoolV43TaskMarket.sol");
  const consensus = source("contracts/v43/AgentPoolV43EvolutionConsensus.sol");
  assert.match(
    market,
    /settlementRouter\.recordAdoption\(\s*proposalId,\s*msg\.sender,\s*receiptId,\s*job\.releaseId/,
  );
  assert.match(consensus, /proposal\.releaseId != releaseId/);
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /a settled job cannot adopt a release that it did not execute/,
  );
});

test("v4.4 candidates return their bond without reopening lifetime Issue caps", () => {
  const gate = source("contracts/v43/AgentPoolV435SystemIssueGate.sol");
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  assert.match(
    gate,
    /candidateBond\[issue\.issueId\]\[operatorGroup\] =\s*dynamicCandidateBond/,
  );
  assert.match(
    gate,
    /ledger\.votingPowerAt\([\s\S]*proposer,[\s\S]*snapshotEpoch,[\s\S]*8[\s\S]*\) == 0/,
  );
  assert.match(gate, /function releaseFor\(/);
  assert.match(
    gate,
    /candidateFinalized\[issueId\]\[operatorGroup\] = true/,
  );
  assert.doesNotMatch(gate, /current\.committedBudget -= budget/);
  assert.doesNotMatch(gate, /current\.candidates--/);
  assert.doesNotMatch(
    gate,
    /groupUsed\[issueId\]\[operatorGroup\] = false/,
  );
  assert.match(gate, /token\.safeTransfer\(proposer, returnedBond\)/);
  assert.equal(
    market.match(/_releaseIssueAdmission\(job\);/g)?.length,
    2,
  );
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /returns the dynamic candidate admission bond/,
  );
  assert.match(
    source("scripts/rehearse-v44-full-mainnet-candidate.mjs"),
    /sameFiniteIssueCannotBeReplayed/,
  );
});

test("v4.4 expiry preserves a completed validator rejection", () => {
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  assert.match(
    market,
    /uint8 proofStatus = proofRegistryV2\.resolutionStatus\(/,
  );
  assert.match(
    market,
    /if \(proofStatus == 2\) \{[\s\S]*MilestoneState\.REJECTED,[\s\S]*JobState\.REJECTED/,
  );
  assert.match(
    source("scripts/rehearse-v44-full-mainnet-candidate.mjs"),
    /expiredValidatorRejectionSlashesBond/,
  );
});

test("v4.4 bootstrap readiness cannot manufacture binding Work Power", () => {
  const ledger = source("contracts/v43/AgentPoolV43ContributionLedger.sol");
  const router = source("contracts/v43/AgentPoolV43SettlementRouter.sol");
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  const transition = source(
    "contracts/v43/AgentPoolV435TransitionIssueConsensus.sol",
  );
  assert.match(
    ledger,
    /function recordBootstrapPerformance\([\s\S]*?_record\([\s\S]*?false[\s\S]*?\);/,
  );
  assert.match(
    router,
    /function recordBootstrapOutcome\([\s\S]*recordBootstrapPerformance/,
  );
  assert.match(
    market,
    /jobGovernanceEligible\[jobId\] = !bootstrapAdmitted/,
  );
  assert.match(transition, /MerkleProof\.verifyCalldata\(/);
  assert.match(transition, /MIN_VALIDATOR_VOTERS = 2/);
  assert.match(transition, /MIN_VALIDATOR_GROUPS = 2/);
  assert.match(transition, /group == proposal\.proposerGroup/);
  assert.doesNotMatch(transition, /votingPowerAt\(/);
  const rehearsal = source(
    "scripts/rehearse-v44-full-mainnet-candidate.mjs",
  );
  assert.match(rehearsal, /bootstrapWorkCreatesNoVotingSettlement/);
  assert.match(rehearsal, /bootstrapWorkerHasNoWorkPower/);
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /rejects a deployment validator controlled by the proposer group/,
  );
});

test("v4.4 mature governance requires 5 voters, 3 groups, quorum, and exact two-thirds cast support", () => {
  const issueConsensus = source(
    "contracts/v43/AgentPoolV432IssueConsensus.sol",
  );
  const evolutionConsensus = source(
    "contracts/v43/AgentPoolV43EvolutionConsensus.sol",
  );
  for (const consensus of [issueConsensus, evolutionConsensus]) {
    assert.match(consensus, /MIN_VOTERS = 5/);
    assert.match(consensus, /MIN_GROUPS = 3/);
    assert.match(
      consensus,
      /proposal\.voterCount >= MIN_VOTERS[\s\S]*proposal\.groupCount >= MIN_GROUPS[\s\S]*cast \* BPS >= total \* QUORUM_BPS[\s\S]*proposal\.yesWeight\) \* 3 >= cast \* 2/,
    );
    assert.doesNotMatch(consensus, /SUPERMAJORITY_BPS = 6_667/);
  }
});

test("v4.4 full rehearsal deploys and settles the exact mainnet graph", () => {
  const rehearsal = source(
    "scripts/rehearse-v44-full-mainnet-candidate.mjs",
  );
  assert.doesNotMatch(rehearsal, /rehearse-v43-public-testnet/);
  assert.match(rehearsal, /buildBootstrapTerms/);
  assert.match(rehearsal, /AgentPoolV44Token/);
  assert.match(rehearsal, /config\.bootstrap\.minimumObjectives/);
  assert.match(
    rehearsal,
    /agentpool\.mainnet\.v44\.exact-graph-rehearsal\/v2/,
  );
  assert.match(rehearsal, /exactBootstrap\.jobSettled/);
  assert.match(rehearsal, /exactBootstrap\.lifetimeCandidateConsumed/);
  assert.match(rehearsal, /exactBootstrap\.sameFiniteIssueCannotBeReplayed/);
});

test("CI reproduces v4.4 evidence and both mainnet rehearsals", () => {
  const workflow = source(".github/workflows/ci.yml");
  assert.match(workflow, /pull_request\.head\.sha/u);
  assert.match(workflow, /git rev-parse HEAD/u);
  assert.match(workflow, /npm audit --audit-level=moderate/u);
  for (const command of [
    "npm run evidence:v4.4:source",
    "npm run evidence:v4.4:source:verify",
    "npm run contracts:rehearse:v4.4:mainnet",
    "npm run contracts:rehearse:v4.4:full",
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(".", "\\.")));
  }
});
