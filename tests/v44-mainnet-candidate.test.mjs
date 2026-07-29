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
  sha256File,
} from "../scripts/lib/v44-mainnet.mjs";
import {
  buildV44ReleaseEvidence,
  verifyV44ReleaseEvidence,
  verifyV44ReleaseEvidenceFile,
} from "../scripts/generate-v44-release-evidence.mjs";

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

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
      const evidencePath = path.join(temporaryDirectory, `${name}.txt`);
      fs.writeFileSync(evidencePath, `evidence:${name}\n`, "utf8");
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
      path.join(temporaryDirectory, "finalSourceReproducibility.txt"),
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
      const evidencePath = path.join(temporaryDirectory, `${name}.txt`);
      fs.writeFileSync(evidencePath, `review:${name}\n`, "utf8");
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
      path.join(temporaryDirectory, "finalSourceReproducibility.txt"),
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
});

test("v4.4 deployment path is Base-mainnet-only and excludes test mocks", () => {
  const deploy = source("scripts/deploy-v44-base-mainnet.mjs");
  const preflight = source("scripts/preflight-v44-base-mainnet.mjs");
  const verify = source("scripts/verify-v44-base-mainnet.mjs");
  const helper = source("scripts/lib/v44-mainnet.mjs");
  for (const script of [deploy, preflight, verify]) {
    assert.match(script, /from "viem\/chains"/);
    assert.doesNotMatch(script, /baseSepolia|84532|MockRandomness|mock verifier/i);
  }
  assert.match(deploy, /AgentPoolV44Token/);
  assert.match(deploy, /confirmations: 2/);
  assert.match(deploy, /V44_RESIDUAL_AUTHORITY/);
  assert.match(deploy, /schemaVersion: 3/);
  assert.match(deploy, /deploymentTransactions/);
  assert.match(deploy, /configurationTransactions/);
  assert.match(deploy, /transactionIntents/);
  assert.match(deploy, /encodeDeployData/);
  assert.match(deploy, /V44_PARTIAL_DEPLOYMENT_TX_MISSING/);
  assert.match(helper, /V44_UNCERTAIN_BROADCAST/);
  assert.match(deploy, /blockTag: "pending"/);
  assert.match(verify, /V44_SOURCE_COMMIT_NOT_HEAD/);
  assert.match(verify, /assertTrackedTreeClean\(\)/);
  assert.match(verify, /assertManifestEvidenceClaims/);
  assert.match(verify, /creationTransaction\.currentArtifact/);
  assert.match(verify, /manifest\.transactionSetComplete/);
  assert.match(verify, /supplyEqualsEpochEmissions/);
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

test("v4.4 dynamic candidates lock a refundable admission bond and release their slot", () => {
  const gate = source("contracts/v43/AgentPoolV435SystemIssueGate.sol");
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");
  assert.match(
    gate,
    /candidateBond\[issue\.issueId\]\[operatorGroup\] =\s*dynamicCandidateBond/,
  );
  assert.match(
    gate,
    /ledger\.votingPowerAt\(proposer, snapshotEpoch, 8\) == 0/,
  );
  assert.match(gate, /function releaseFor\(/);
  assert.match(gate, /current\.committedBudget -= budget/);
  assert.match(gate, /current\.candidates--/);
  assert.match(gate, /token\.safeTransfer\(proposer, returnedBond\)/);
  assert.equal(
    market.match(/_releaseIssueAdmission\(job\);/g)?.length,
    2,
  );
  assert.match(
    source("scripts/rehearse-v43-public-testnet.mjs"),
    /returns the dynamic candidate admission bond/,
  );
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
  assert.match(rehearsal, /exactBootstrap\.candidateSlotReleased/);
});

test("CI reproduces v4.4 evidence and both mainnet rehearsals", () => {
  const workflow = source(".github/workflows/ci.yml");
  for (const command of [
    "npm run evidence:v4.4:source",
    "npm run evidence:v4.4:source:verify",
    "npm run contracts:rehearse:v4.4:mainnet",
    "npm run contracts:rehearse:v4.4:full",
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(".", "\\.")));
  }
});
