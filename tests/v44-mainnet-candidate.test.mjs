import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { keccak256, toBytes } from "viem";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  artifact,
  artifactBytecodeEvidence,
  buildBootstrapTerms,
  collectReleaseInputs,
  currentGitCommit,
  loadAndValidateConfig,
  loadAndValidateGates,
} from "../scripts/lib/v44-mainnet.mjs";
import {
  buildV44ReleaseEvidence,
  verifyV44ReleaseEvidence,
} from "../scripts/generate-v44-release-evidence.mjs";

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
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
  assert.match(rehearsal, /const statefulCases = 32/);
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
  assert.equal(evidence.compilerSettings.optimizer.runs, 500);
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
  tampered.compilerSettings.optimizer.runs = 1;
  assert.throws(
    () => verifyV44ReleaseEvidence(tampered, { requireClean: false }),
    /V44_SOURCE_EVIDENCE_MISMATCH/,
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
      (gate) => gate.status === "blocked" && gate.evidenceSha256 === null,
    ),
  );
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
    V44_BOOTSTRAP_CAPABILITY_HASH: `0x${"02".repeat(32)}`,
    V44_BOOTSTRAP_SPECIFICATION_HASH: `0x${"03".repeat(32)}`,
    V44_BOOTSTRAP_DELIVERY_HASH: `0x${"04".repeat(32)}`,
    V44_BOOTSTRAP_OBJECTIVE_PROOF_HEX: "0x0102",
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
    V44_BOOTSTRAP_CAPABILITY_HASH: `0x${"42".repeat(32)}`,
    V44_BOOTSTRAP_SPECIFICATION_HASH: `0x${"43".repeat(32)}`,
    V44_BOOTSTRAP_DELIVERY_HASH: `0x${"44".repeat(32)}`,
    V44_BOOTSTRAP_OBJECTIVE_PROOF_HEX: "0x01020304",
    V44_GENESIS_MODULE_HASH: `0x${"45".repeat(32)}`,
    V44_GENESIS_MANIFEST_HASH: `0x${"46".repeat(32)}`,
  };
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
  assert.equal(terms.issue.bootstrapProposer, env.V44_BOOTSTRAP_PROPOSER);
});

test("v4.4 deployment path is Base-mainnet-only and excludes test mocks", () => {
  const deploy = source("scripts/deploy-v44-base-mainnet.mjs");
  const preflight = source("scripts/preflight-v44-base-mainnet.mjs");
  const verify = source("scripts/verify-v44-base-mainnet.mjs");
  for (const script of [deploy, preflight, verify]) {
    assert.match(script, /from "viem\/chains"/);
    assert.doesNotMatch(script, /baseSepolia|84532|MockRandomness|mock verifier/i);
  }
  assert.match(deploy, /AgentPoolV44Token/);
  assert.match(deploy, /confirmations: 2/);
  assert.match(deploy, /V44_RESIDUAL_AUTHORITY/);
  assert.match(verify, /supplyEqualsEpochEmissions/);
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
