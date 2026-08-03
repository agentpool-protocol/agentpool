import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseEther,
  toBytes,
} from "viem";

export const ROOT = process.cwd();
export const CHAIN_ID = 8453;
export const NETWORK = "Base";
export const VERSION = "4.4.0-ownerless-mainnet-candidate";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
export const MAX_CONTRIBUTION_UNITS_PER_MILESTONE = 1_000_000;
export const V44_REQUIRED_GATES = Object.freeze([
  "finalSourceReproducibility",
  "independentSecurityReview",
  "publicTestnetReliability",
  "validatorIndependence",
  "economicInvariantReview",
  "deployerLegalAssessment",
  "nameAndSymbolClearance",
]);
export const V44_GATE_EVIDENCE = Object.freeze({
  finalSourceReproducibility: Object.freeze({
    owner: "release-reproducibility",
    schema: "agentpool.mainnet.v44.source-reproducibility/v1",
  }),
  independentSecurityReview: Object.freeze({
    owner: "independent-security-reviewers",
    schema: "agentpool.mainnet.v44.independent-security-review/v1",
  }),
  publicTestnetReliability: Object.freeze({
    owner: "public-testnet-observers",
    schema: "agentpool.mainnet.v44.public-testnet-reliability/v1",
  }),
  validatorIndependence: Object.freeze({
    owner: "validator-groups",
    schema: "agentpool.mainnet.v44.validator-independence/v1",
  }),
  economicInvariantReview: Object.freeze({
    owner: "protocol-economics-reviewers",
    schema: "agentpool.mainnet.v44.economic-invariant-review/v1",
  }),
  deployerLegalAssessment: Object.freeze({
    owner: "actual-mainnet-deployer",
    schema: "agentpool.mainnet.v44.deployer-legal-assessment/v1",
  }),
  nameAndSymbolClearance: Object.freeze({
    owner: "release-community",
    schema: "agentpool.mainnet.v44.name-symbol-clearance/v1",
  }),
});

export const CONTRACT_TYPES = Object.freeze({
  token: "AgentPoolV44Token",
  policyAnchor: "AgentPoolV44PolicyAnchor",
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
});

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest("hex");
}

export function redactBootstrapSecrets(bootstrap) {
  if (!bootstrap || !Array.isArray(bootstrap.objectives)) {
    throw new Error("V44_BOOTSTRAP_EVIDENCE_INVALID");
  }
  return {
    ...bootstrap,
    objectives: bootstrap.objectives.map((entry) => {
      const publicEntry = { ...entry };
      delete publicEntry.deliveryHash;
      delete publicEntry.objectiveProof;
      return publicEntry;
    }),
  };
}

export function artifact(name) {
  const filePath = path.join(ROOT, "artifacts", `${name}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`V44_ARTIFACT_MISSING:${name}`);
  const compiled = readJson(filePath);
  if (
    !Array.isArray(compiled.abi) ||
    typeof compiled.bytecode !== "string" ||
    compiled.bytecode === "0x" ||
    typeof compiled.deployedBytecode !== "string" ||
    compiled.deployedBytecode === "0x"
  ) {
    throw new Error(`V44_ARTIFACT_INVALID:${name}`);
  }
  return compiled;
}

export function requireEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

export function requireAddress(name, env = process.env) {
  const value = requireEnv(name, env);
  if (!isAddress(value)) throw new Error(`${name}_INVALID`);
  return getAddress(value);
}

export function requireBytes32(name, env = process.env) {
  const value = requireEnv(name, env);
  if (!HASH_PATTERN.test(value) || value.toLowerCase() === ZERO_BYTES32) {
    throw new Error(`${name}_INVALID`);
  }
  return value.toLowerCase();
}

export function requireHex(name, env = process.env) {
  const value = requireEnv(name, env);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value.toLowerCase();
}

export function pairHash(left, right) {
  return keccak256(
    left.toLowerCase() < right.toLowerCase()
      ? concatHex([left, right])
      : concatHex([right, left]),
  );
}

export function merkleCatalog(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error("V44_MERKLE_LEAVES_EMPTY");
  }
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const level = layers.at(-1);
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(pairHash(level[index], level[index + 1] ?? level[index]));
    }
    layers.push(next);
  }
  return {
    root: layers.at(-1)[0],
    proofs: leaves.map((_, originalIndex) => {
      const proof = [];
      let index = originalIndex;
      for (let depth = 0; depth < layers.length - 1; depth += 1) {
        const level = layers[depth];
        proof.push(level[index ^ 1] ?? level[index]);
        index = Math.floor(index / 2);
      }
      return proof;
    }),
  };
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`V44_CONFIG_INVALID:${label}`);
  }
}

function assertDecimalString(value, label, { positive = true } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`V44_CONFIG_INVALID:${label}`);
  }
  if (positive && BigInt(value) === 0n) {
    throw new Error(`V44_CONFIG_INVALID:${label}`);
  }
}

export function loadAndValidateConfig(
  filePath = path.join(ROOT, "mainnet-v44-config.json"),
) {
  const config = readJson(filePath);
  if (
    config.schema !== "agentpool.mainnet.v44.config/v1" ||
    config.chainId !== CHAIN_ID ||
    config.network !== NETWORK ||
    config.release !== VERSION
  ) {
    throw new Error("V44_CONFIG_IDENTITY_INVALID");
  }
  if (
    config.token?.name !== "AgentPool" ||
    config.token?.symbol !== "APOOL" ||
    config.token?.decimals !== 18 ||
    config.token?.premintApool !== "0"
  ) {
    throw new Error("V44_TOKEN_CONFIG_INVALID");
  }
  for (const [label, value] of [
    ["token.maxSupplyApool", config.token?.maxSupplyApool],
    ["emission.coreWeeklyCapApool", config.emission?.coreWeeklyCapApool],
    ["emission.evolutionWeeklyCapApool", config.emission?.evolutionWeeklyCapApool],
    ["emission.coreLifetimeCapApool", config.emission?.coreLifetimeCapApool],
    ["emission.evolutionLifetimeCapApool", config.emission?.evolutionLifetimeCapApool],
    ["dynamicIssues.candidateBudgetCapApool", config.dynamicIssues?.candidateBudgetCapApool],
    ["dynamicIssues.issueBudgetCapApool", config.dynamicIssues?.issueBudgetCapApool],
    ["dynamicIssues.candidateAdmissionBondApool", config.dynamicIssues?.candidateAdmissionBondApool],
    ["consensus.proposalBondApool", config.consensus?.proposalBondApool],
    ["bootstrap.candidateBudgetCapApool", config.bootstrap?.candidateBudgetCapApool],
    ["bootstrap.totalBudgetCapApool", config.bootstrap?.totalBudgetCapApool],
  ]) {
    assertDecimalString(value, label);
  }
  for (const [label, value, minimum] of [
    ["emission.epochSeconds", config.emission?.epochSeconds, 1],
    ["dynamicIssues.maxCandidates", config.dynamicIssues?.maxCandidates, 1],
    ["dynamicIssues.maxLifetimeSeconds", config.dynamicIssues?.maxLifetimeSeconds, 1],
    ["bootstrap.maxCandidates", config.bootstrap?.maxCandidates, 1],
    ["bootstrap.minimumReveals", config.bootstrap?.minimumReveals, 3],
    ["bootstrap.passScoreBps", config.bootstrap?.passScoreBps, 1],
    ["bootstrap.minimumValidatorGroups", config.bootstrap?.minimumValidatorGroups, 3],
    ["bootstrap.capacityUnits", config.bootstrap?.capacityUnits, 1],
    ["bootstrap.minimumObjectives", config.bootstrap?.minimumObjectives, 24],
    ["bootstrap.maximumObjectives", config.bootstrap?.maximumObjectives, 20],
    ["bootstrap.funding", config.bootstrap?.funding, 0],
    ["bootstrap.maximumLifetimeSeconds", config.bootstrap?.maximumLifetimeSeconds, 1],
  ]) {
    assertInteger(value, label, minimum);
  }
  if (config.emission.epochSeconds !== 604_800) {
    throw new Error("V44_EPOCH_DURATION_MUST_BE_ONE_WEEK");
  }
  if (config.dynamicIssues.maxCandidates !== 1) {
    throw new Error("V44_PRE_MATURE_DYNAMIC_CANDIDATES_MUST_EQUAL_ONE");
  }
  if (
    BigInt(config.emission.coreLifetimeCapApool) +
      BigInt(config.emission.evolutionLifetimeCapApool) !==
    BigInt(config.token.maxSupplyApool)
  ) {
    throw new Error("V44_LIFETIME_CAPS_MUST_EQUAL_MAX_SUPPLY");
  }
  if (
    BigInt(config.emission.coreWeeklyCapApool) >
      BigInt(config.emission.coreLifetimeCapApool) ||
    BigInt(config.emission.evolutionWeeklyCapApool) >
      BigInt(config.emission.evolutionLifetimeCapApool)
  ) {
    throw new Error("V44_WEEKLY_CAP_EXCEEDS_LIFETIME_CAP");
  }
  if (
    BigInt(config.dynamicIssues.candidateBudgetCapApool) *
      BigInt(config.dynamicIssues.maxCandidates) >
    BigInt(config.dynamicIssues.issueBudgetCapApool)
  ) {
    throw new Error("V44_DYNAMIC_CANDIDATE_BUDGETS_EXCEED_ISSUE_CAP");
  }
  if (
    config.bootstrap.minimumValidatorGroups >
      config.bootstrap.minimumReveals ||
    config.bootstrap.passScoreBps > 10_000 ||
    config.bootstrap.capacityUnits >
      MAX_CONTRIBUTION_UNITS_PER_MILESTONE ||
    config.bootstrap.minimumObjectives < 24 ||
    config.bootstrap.maximumObjectives > 32 ||
    config.bootstrap.minimumObjectives >
      config.bootstrap.maximumObjectives ||
    config.bootstrap.funding !== 3
  ) {
    throw new Error("V44_BOOTSTRAP_CONFIG_INVALID");
  }
  const expectedInvariants = [
    "max-supply",
    "external-no-mint",
    "reservation-cap",
    "no-owner-withdrawal",
    "no-evaluator-payout",
    "receipt-replay",
  ];
  if (
    JSON.stringify(config.invariants) !== JSON.stringify(expectedInvariants)
  ) {
    throw new Error("V44_FINANCE_INVARIANTS_INVALID");
  }
  return {
    config,
    configPath: filePath,
    configSha256: sha256File(filePath),
    financeInvariantHash: keccak256(toBytes(config.invariants.join("|"))),
  };
}

function envNameForGate(gateName) {
  return `V44_GATE_${gateName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()}_SHA256`;
}

export function loadAndValidateGates(
  env = process.env,
  filePath = null,
) {
  const configuredPath =
    filePath ??
    env.V44_GATES_FILE?.trim() ??
    path.join(ROOT, "mainnet-v44-gates.json");
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(ROOT, configuredPath);
  const gates = readJson(resolvedPath);
  if (
    gates.schema !== "agentpool.mainnet.v44.gates/v2" ||
    gates.chainId !== CHAIN_ID ||
    gates.network !== "base-mainnet" ||
    gates.release !== VERSION
  ) {
    throw new Error("V44_GATES_IDENTITY_INVALID");
  }
  const configuredGateNames = Object.keys(gates.gates ?? {}).sort();
  const requiredGateNames = [...V44_REQUIRED_GATES].sort();
  if (
    configuredGateNames.length !== requiredGateNames.length ||
    configuredGateNames.some(
      (name, index) => name !== requiredGateNames[index],
    )
  ) {
    throw new Error("V44_GATE_SET_INVALID");
  }
  const approved = {};
  const evidencePaths = {};
  const seenEvidencePaths = new Set();
  const seenEvidenceDigests = new Set();
  for (const name of V44_REQUIRED_GATES) {
    const gate = gates.gates[name];
    const policy = V44_GATE_EVIDENCE[name];
    if (
      gate?.status !== "approved" ||
      !SHA256_PATTERN.test(gate.evidenceSha256 ?? "") ||
      gate.evidenceSha256 === ZERO_SHA256
    ) {
      throw new Error(`V44_GATE_BLOCKED:${name}`);
    }
    if (gate.evidenceOwner !== policy.owner) {
      throw new Error(`V44_GATE_EVIDENCE_OWNER_INVALID:${name}`);
    }
    if (
      typeof gate.evidenceFile !== "string" ||
      gate.evidenceFile.trim().length === 0
    ) {
      throw new Error(`V44_GATE_EVIDENCE_FILE_MISSING:${name}`);
    }
    const evidencePath = path.isAbsolute(gate.evidenceFile)
      ? path.resolve(gate.evidenceFile)
      : path.resolve(path.dirname(resolvedPath), gate.evidenceFile);
    if (
      evidencePath === resolvedPath ||
      !fs.existsSync(evidencePath) ||
      !fs.statSync(evidencePath).isFile() ||
      fs.statSync(evidencePath).size === 0
    ) {
      throw new Error(`V44_GATE_EVIDENCE_FILE_INVALID:${name}`);
    }
    const normalizedEvidencePath = evidencePath.toLowerCase();
    if (seenEvidencePaths.has(normalizedEvidencePath)) {
      throw new Error(`V44_GATE_EVIDENCE_PATH_REUSED:${name}`);
    }
    seenEvidencePaths.add(normalizedEvidencePath);
    const actualEvidenceSha256 = sha256File(evidencePath);
    if (actualEvidenceSha256 !== gate.evidenceSha256.toLowerCase()) {
      throw new Error(`V44_GATE_EVIDENCE_CONTENT_MISMATCH:${name}`);
    }
    if (seenEvidenceDigests.has(actualEvidenceSha256)) {
      throw new Error(`V44_GATE_EVIDENCE_DIGEST_REUSED:${name}`);
    }
    seenEvidenceDigests.add(actualEvidenceSha256);
    let evidence;
    try {
      evidence = readJson(evidencePath);
    } catch {
      throw new Error(`V44_GATE_EVIDENCE_JSON_INVALID:${name}`);
    }
    if (evidence?.schema !== policy.schema) {
      throw new Error(`V44_GATE_EVIDENCE_SCHEMA_INVALID:${name}`);
    }
    const expectedCommit = currentGitCommit().toLowerCase();
    if (
      evidence.release !== VERSION ||
      evidence.sourceCommit?.toLowerCase() !== expectedCommit
    ) {
      throw new Error(`V44_GATE_EVIDENCE_RELEASE_INVALID:${name}`);
    }
    if (name === "finalSourceReproducibility") {
      if (evidence.chainId !== CHAIN_ID) {
        throw new Error(`V44_GATE_EVIDENCE_CHAIN_INVALID:${name}`);
      }
    } else {
      if (
        evidence.targetChainId !== CHAIN_ID ||
        evidence.decision !== "approved"
      ) {
        throw new Error(`V44_GATE_EVIDENCE_DECISION_INVALID:${name}`);
      }
      if (
        name === "publicTestnetReliability" &&
        (evidence.observedChainId !== 84532 || evidence.eligible !== true)
      ) {
        throw new Error(`V44_GATE_EVIDENCE_RELIABILITY_INVALID:${name}`);
      }
      if (
        (
          name === "independentSecurityReview" ||
          name === "economicInvariantReview"
        ) &&
        (!Array.isArray(evidence.reviewers) ||
          evidence.reviewers.length < 2)
      ) {
        throw new Error(`V44_GATE_EVIDENCE_REVIEWERS_INVALID:${name}`);
      }
      if (
        name === "validatorIndependence" &&
        (!Array.isArray(evidence.validators) ||
          evidence.validators.length < 3)
      ) {
        throw new Error(`V44_GATE_EVIDENCE_VALIDATORS_INVALID:${name}`);
      }
      if (
        name === "deployerLegalAssessment" &&
        (
          !isAddress(evidence.actualDeployerAddress ?? "") ||
          !Array.isArray(evidence.jurisdictions) ||
          evidence.jurisdictions.length === 0
        )
      ) {
        throw new Error(`V44_GATE_EVIDENCE_LEGAL_INVALID:${name}`);
      }
      if (
        name === "nameAndSymbolClearance" &&
        evidence.conflictsCleared !== true
      ) {
        throw new Error(`V44_GATE_EVIDENCE_NAME_INVALID:${name}`);
      }
    }
    const envName = envNameForGate(name);
    const supplied = requireEnv(envName, env).toLowerCase();
    if (!SHA256_PATTERN.test(supplied) || supplied === ZERO_SHA256) {
      throw new Error(`${envName}_INVALID`);
    }
    if (supplied !== gate.evidenceSha256.toLowerCase()) {
      throw new Error(`V44_GATE_EVIDENCE_MISMATCH:${name}`);
    }
    approved[name] = supplied;
    evidencePaths[name] = evidencePath;
  }
  return {
    gates,
    gatesPath: resolvedPath,
    gatesSha256: sha256File(resolvedPath),
    approved,
    evidencePaths,
  };
}

export function bootstrapIdentitySha256(releaseInputs) {
  return sha256Json({
    proposer: releaseInputs.bootstrap.proposer,
    issueId: releaseInputs.bootstrap.issueId,
    validators: releaseInputs.bootstrap.validators.map((entry) => ({
      address: entry.address,
      group: entry.group,
    })),
  });
}

export function assertManifestEvidenceClaims({
  manifest,
  gateEvidence,
  sourceEvidence,
  releaseInputs,
  artifacts = artifactBytecodeEvidence(),
}) {
  if (
    sha256Json(manifest.approvedGateEvidence) !==
    sha256Json(gateEvidence.approved)
  ) {
    throw new Error("V44_MANIFEST_GATE_EVIDENCE_MISMATCH");
  }
  if (
    manifest.sourceEvidenceFileSha256 !==
      gateEvidence.approved.finalSourceReproducibility ||
    manifest.sourceEvidenceBodySha256 !== sourceEvidence.evidenceSha256
  ) {
    throw new Error("V44_MANIFEST_SOURCE_EVIDENCE_MISMATCH");
  }
  if (
    manifest.bootstrapIdentitySha256 !==
    bootstrapIdentitySha256(releaseInputs)
  ) {
    throw new Error("V44_MANIFEST_BOOTSTRAP_IDENTITY_MISMATCH");
  }
  if (sha256Json(manifest.artifactBytecode) !== sha256Json(artifacts)) {
    throw new Error("V44_MANIFEST_ARTIFACT_EVIDENCE_MISMATCH");
  }
  return true;
}

export function currentGitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

const V44_RELEASE_ENTRYPOINTS = Object.freeze([
  "scripts/deploy-v44-base-mainnet.mjs",
  "scripts/preflight-v44-base-mainnet.mjs",
  "scripts/reconcile-v44-mainnet-intent.mjs",
  "scripts/verify-v44-base-mainnet.mjs",
  "scripts/generate-v44-public-testnet-reliability.mjs",
  "scripts/generate-v44-release-evidence.mjs",
]);

const V44_RELEASE_DATA_FILES = Object.freeze([
  "mainnet-v44-config.json",
  "mainnet-v44-gates.json",
  "mainnet-v44-testnet-reliability-policy.json",
]);

function relativeModuleSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gsu,
    /import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gsu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveLocalModule(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [
    unresolved,
    `${unresolved}.mjs`,
    `${unresolved}.js`,
    path.join(unresolved, "index.mjs"),
    path.join(unresolved, "index.js"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(
    `V44_RELEASE_DEPENDENCY_MISSING:${path.relative(ROOT, unresolved)}`,
  );
}

export function assertReleaseDependenciesTracked(trackedPaths) {
  const queue = V44_RELEASE_ENTRYPOINTS.map((relativePath) =>
    path.join(ROOT, relativePath),
  );
  for (const relativePath of V44_RELEASE_DATA_FILES) {
    if (!trackedPaths.has(relativePath)) {
      throw new Error(`V44_RELEASE_DEPENDENCY_UNTRACKED:${relativePath}`);
    }
  }
  const visited = new Set();
  while (queue.length > 0) {
    const absolutePath = queue.pop();
    const relativePath = path
      .relative(ROOT, absolutePath)
      .replaceAll("\\", "/");
    if (
      relativePath.startsWith("../") ||
      path.isAbsolute(relativePath) ||
      !trackedPaths.has(relativePath)
    ) {
      throw new Error(`V44_RELEASE_DEPENDENCY_UNTRACKED:${relativePath}`);
    }
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    for (const specifier of relativeModuleSpecifiers(source)) {
      queue.push(resolveLocalModule(absolutePath, specifier));
    }
  }
}

export function assertTrackedTreeClean() {
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    try {
      execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
    } catch {
      throw new Error("V44_TRACKED_WORKTREE_NOT_CLEAN");
    }
  }
  const flagged = execFileSync("git", ["ls-files", "-v"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => !line.startsWith("H "));
  if (flagged.length !== 0) {
    throw new Error(`V44_GIT_INDEX_FLAGGED:${flagged[0]}`);
  }
  const tracked = execFileSync(
    "git",
    ["ls-tree", "-r", "--format=%(objectname)\t%(path)", "HEAD"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const trackedPaths = new Set(
    tracked.map((line) => line.slice(line.indexOf("\t") + 1)),
  );
  assertReleaseDependenciesTracked(trackedPaths);
  for (const line of tracked) {
    const separator = line.indexOf("\t");
    const expectedBlob = line.slice(0, separator);
    const relativePath = line.slice(separator + 1);
    const actualBlob = execFileSync(
      "git",
      ["hash-object", "--", relativePath],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    if (actualBlob !== expectedBlob) {
      throw new Error(`V44_WORKTREE_BLOB_MISMATCH:${relativePath}`);
    }
  }
}

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export function assertDeploymentProvenance({
  key,
  expectedFrom,
  expectedInput,
  expectedAddress,
  transaction,
  receipt,
}) {
  if (receipt?.status !== "success") {
    throw new Error(`V44_DEPLOYMENT_RECEIPT_FAILED:${key}`);
  }
  if (!sameAddress(transaction?.from, expectedFrom)) {
    throw new Error(`V44_DEPLOYMENT_FROM_MISMATCH:${key}`);
  }
  if (transaction?.input?.toLowerCase() !== expectedInput.toLowerCase()) {
    throw new Error(`V44_DEPLOYMENT_INPUT_MISMATCH:${key}`);
  }
  if (!receipt.contractAddress) {
    throw new Error(`V44_DEPLOYMENT_ADDRESS_MISSING:${key}`);
  }
  if (
    expectedAddress &&
    !sameAddress(receipt.contractAddress, expectedAddress)
  ) {
    throw new Error(`V44_DEPLOYMENT_ADDRESS_MISMATCH:${key}`);
  }
  return getAddress(receipt.contractAddress);
}

export function assertConfigurationProvenance({
  key,
  expectedFrom,
  expectedTo,
  expectedInput,
  transaction,
  receipt,
}) {
  if (receipt?.status !== "success") {
    throw new Error(`V44_CONFIGURATION_RECEIPT_FAILED:${key}`);
  }
  if (!sameAddress(transaction?.from, expectedFrom)) {
    throw new Error(`V44_CONFIGURATION_FROM_MISMATCH:${key}`);
  }
  if (!sameAddress(transaction?.to, expectedTo)) {
    throw new Error(`V44_CONFIGURATION_TO_MISMATCH:${key}`);
  }
  if (transaction?.input?.toLowerCase() !== expectedInput.toLowerCase()) {
    throw new Error(`V44_CONFIGURATION_INPUT_MISMATCH:${key}`);
  }
}

export function beginTransactionIntent({
  intents,
  key,
  kind,
  nonce,
  to,
  inputHash,
  createdAt = new Date().toISOString(),
}) {
  if (intents[key]) throw new Error(`V44_UNCERTAIN_BROADCAST:${key}`);
  intents[key] = {
    kind,
    nonce,
    to,
    inputHash,
    createdAt,
  };
  return intents[key];
}

export function attachTransactionHash({ intents, key, hash }) {
  const intent = intents[key];
  if (!intent) throw new Error(`V44_TRANSACTION_INTENT_MISSING:${key}`);
  if (intent.hash && intent.hash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`V44_TRANSACTION_HASH_MISMATCH:${key}`);
  }
  intent.hash = hash;
  return intent;
}

export function assertTransactionMatchesIntent({
  key,
  intent,
  expectedFrom,
  transaction,
}) {
  if (!intent || !transaction) {
    throw new Error(`V44_RECONCILE_TRANSACTION_MISSING:${key}`);
  }
  if (!sameAddress(transaction.from, expectedFrom)) {
    throw new Error(`V44_RECONCILE_FROM_MISMATCH:${key}`);
  }
  if (BigInt(transaction.nonce) !== BigInt(intent.nonce)) {
    throw new Error(`V44_RECONCILE_NONCE_MISMATCH:${key}`);
  }
  if (
    (intent.to === null && transaction.to !== null) ||
    (intent.to !== null && !sameAddress(transaction.to, intent.to))
  ) {
    throw new Error(`V44_RECONCILE_TO_MISMATCH:${key}`);
  }
  if (
    typeof transaction.input !== "string" ||
    keccak256(transaction.input).toLowerCase() !==
      intent.inputHash.toLowerCase()
  ) {
    throw new Error(`V44_RECONCILE_INPUT_MISMATCH:${key}`);
  }
  return true;
}

export function collectReleaseInputs({
  env = process.env,
  deployerAddress,
  now = Math.floor(Date.now() / 1_000),
  allowPastGenesis = false,
} = {}) {
  const sourceCommit = requireEnv("V44_SOURCE_COMMIT", env).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("V44_SOURCE_COMMIT_INVALID");
  }
  if (sourceCommit !== currentGitCommit().toLowerCase()) {
    throw new Error("V44_SOURCE_COMMIT_NOT_HEAD");
  }
  const genesisStart = Number(requireEnv("V44_GENESIS_TIMESTAMP", env));
  if (!Number.isSafeInteger(genesisStart)) {
    throw new Error("V44_GENESIS_TIMESTAMP_INVALID");
  }
  if (
    !allowPastGenesis &&
    (genesisStart < now + 72 * 3_600 ||
      genesisStart > now + 30 * 86_400)
  ) {
    throw new Error("V44_GENESIS_MUST_BE_72_HOURS_TO_30_DAYS_AHEAD");
  }
  const bootstrapProposer = requireAddress("V44_BOOTSTRAP_PROPOSER", env);
  const validators = [1, 2, 3].map((index) => ({
    address: requireAddress(`V44_VALIDATOR_${index}`, env),
    group: requireBytes32(`V44_VALIDATOR_${index}_GROUP_ID`, env),
  }));
  const addresses = [
    ...(deployerAddress ? [getAddress(deployerAddress)] : []),
    bootstrapProposer,
    ...validators.map((entry) => entry.address),
  ];
  if (
    new Set(addresses.map((address) => address.toLowerCase())).size !==
    addresses.length
  ) {
    throw new Error("V44_DEPLOYER_PROPOSER_VALIDATORS_MUST_BE_DISTINCT");
  }
  if (
    new Set(validators.map((entry) => entry.group.toLowerCase())).size !==
    validators.length
  ) {
    throw new Error("V44_VALIDATOR_GROUPS_MUST_BE_DISTINCT");
  }
  const objectivesPath = path.resolve(
    ROOT,
    requireEnv("V44_BOOTSTRAP_OBJECTIVES_FILE", env),
  );
  if (!fs.existsSync(objectivesPath)) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVES_MISSING");
  }
  const objectivesSha256 = sha256File(objectivesPath);
  const expectedObjectivesSha256 = requireEnv(
    "V44_BOOTSTRAP_OBJECTIVES_SHA256",
    env,
  ).toLowerCase();
  if (
    !SHA256_PATTERN.test(expectedObjectivesSha256) ||
    objectivesSha256 !== expectedObjectivesSha256
  ) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVES_SHA256_MISMATCH");
  }
  const objectiveCatalog = readJson(objectivesPath);
  if (
    objectiveCatalog.schema !==
      "agentpool.mainnet.v44.bootstrap-objectives/v1" ||
    !Array.isArray(objectiveCatalog.objectives) ||
    objectiveCatalog.objectives.length < 24 ||
    objectiveCatalog.objectives.length > 32
  ) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVES_INVALID");
  }
  const objectives = objectiveCatalog.objectives.map((entry, index) => {
    const capabilityHash = entry?.capabilityHash;
    const specificationHash = entry?.specificationHash;
    const deliveryHash = entry?.deliveryHash;
    const objectiveProof = entry?.objectiveProofHex;
    const capacityUnits = entry?.capacityUnits;
    for (const [label, value] of [
      ["capabilityHash", capabilityHash],
      ["specificationHash", specificationHash],
      ["deliveryHash", deliveryHash],
    ]) {
      if (
        typeof value !== "string" ||
        !HASH_PATTERN.test(value) ||
        value.toLowerCase() === ZERO_BYTES32
      ) {
        throw new Error(
          `V44_BOOTSTRAP_OBJECTIVE_INVALID:${index}:${label}`,
        );
      }
    }
    if (
      typeof objectiveProof !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2}){32,}$/.test(objectiveProof) ||
      !Number.isInteger(capacityUnits) ||
      capacityUnits < 1 ||
      capacityUnits > MAX_CONTRIBUTION_UNITS_PER_MILESTONE
    ) {
      throw new Error(`V44_BOOTSTRAP_OBJECTIVE_INVALID:${index}`);
    }
    return {
      capabilityHash: capabilityHash.toLowerCase(),
      specificationHash: specificationHash.toLowerCase(),
      deliveryHash: deliveryHash.toLowerCase(),
      objectiveProof: objectiveProof.toLowerCase(),
      capacityUnits,
    };
  });
  const objectiveIdentities = objectives.map((entry) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint32" },
        ],
        [
          entry.capabilityHash,
          entry.specificationHash,
          entry.deliveryHash,
          keccak256(entry.objectiveProof),
          entry.capacityUnits,
        ],
      ),
    ),
  );
  if (new Set(objectiveIdentities).size !== objectiveIdentities.length) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVES_DUPLICATE");
  }
  const bootstrap = {
    proposer: bootstrapProposer,
    validators,
    issueId: requireBytes32("V44_BOOTSTRAP_ISSUE_ID", env),
    objectives,
    objectivesPath,
    objectivesSha256,
  };
  const genesisModuleHash = requireBytes32("V44_GENESIS_MODULE_HASH", env);
  const genesisManifestHash = requireBytes32("V44_GENESIS_MANIFEST_HASH", env);
  const genesisRelease = keccak256(
    encodeAbiParameters(
      [{ type: "bytes20" }, { type: "bytes32" }, { type: "bytes32" }],
      [`0x${sourceCommit}`, genesisModuleHash, genesisManifestHash],
    ),
  );
  return {
    sourceCommit,
    genesisStart,
    genesisRelease,
    genesisModuleHash,
    genesisManifestHash,
    bootstrap,
  };
}

export function buildBootstrapTerms({
  config,
  releaseInputs,
  verifier,
}) {
  if (!isAddress(verifier) || getAddress(verifier) === ZERO_ADDRESS) {
    throw new Error("V44_VERIFIER_ADDRESS_INVALID");
  }
  const validators = releaseInputs.bootstrap.validators;
  const validatorLeaves = validators.map((entry) => {
    const inner = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [entry.address, entry.group],
      ),
    );
    return keccak256(
      encodeAbiParameters([{ type: "bytes32" }], [inner]),
    );
  });
  const validatorCatalog = merkleCatalog(validatorLeaves);
  if (
    releaseInputs.bootstrap.objectives.length <
      config.bootstrap.minimumObjectives ||
    releaseInputs.bootstrap.objectives.length >
      config.bootstrap.maximumObjectives
  ) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVE_COUNT_INVALID");
  }
  const objectives = releaseInputs.bootstrap.objectives.map((entry) => {
    if (entry.capacityUnits > config.bootstrap.capacityUnits) {
      throw new Error("V44_BOOTSTRAP_OBJECTIVE_CAPACITY_EXCEEDED");
    }
    const expectedEvidenceHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [
          entry.specificationHash,
          entry.deliveryHash,
          keccak256(entry.objectiveProof),
        ],
      ),
    );
    const objectiveInner = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint32" },
          { type: "uint16" },
          { type: "uint16" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "bytes32" },
          { type: "uint16" },
        ],
        [
          getAddress(verifier),
          entry.capabilityHash,
          entry.specificationHash,
          expectedEvidenceHash,
          entry.capacityUnits,
          config.bootstrap.minimumReveals,
          config.bootstrap.passScoreBps,
          60,
          60,
          validatorCatalog.root,
          config.bootstrap.minimumValidatorGroups,
        ],
      ),
    );
    return {
      ...entry,
      expectedEvidenceHash,
      leaf: keccak256(
        encodeAbiParameters([{ type: "bytes32" }], [objectiveInner]),
      ),
    };
  });
  if (new Set(objectives.map((entry) => entry.leaf)).size !== objectives.length) {
    throw new Error("V44_BOOTSTRAP_OBJECTIVE_LEAVES_DUPLICATE");
  }
  const objectiveCatalog = merkleCatalog(
    objectives.map((entry) => entry.leaf),
  );
  const objectiveRoot = objectiveCatalog.root;
  const catalogDigest = `0x${releaseInputs.bootstrap.objectivesSha256}`;
  const expectedEvidenceHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [objectiveRoot, validatorCatalog.root],
    ),
  );
  const issue = {
    issueId: releaseInputs.bootstrap.issueId,
    bootstrapProposer: releaseInputs.bootstrap.proposer,
    specificationHash: catalogDigest,
    verifier: getAddress(verifier),
    expectedEvidenceHash,
    objectiveRoot,
    validatorRoot: validatorCatalog.root,
    candidateBudgetCap: parseEther(
      config.bootstrap.candidateBudgetCapApool,
    ),
    totalBudgetCap: parseEther(config.bootstrap.totalBudgetCapApool),
    maxCandidates: config.bootstrap.maxCandidates,
    minimumReveals: config.bootstrap.minimumReveals,
    passScoreBps: config.bootstrap.passScoreBps,
    minimumValidatorGroups: config.bootstrap.minimumValidatorGroups,
    funding: config.bootstrap.funding,
    expiresAt:
      releaseInputs.genesisStart +
      config.bootstrap.maximumLifetimeSeconds,
  };
  const issueRoot = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
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
          ],
        },
      ],
      [issue],
    ),
  );
  return {
    issue,
    issueRoot,
    objectiveRoot,
    expectedEvidenceHash,
    objectives: objectives.map((entry, index) => ({
      ...entry,
      proof: objectiveCatalog.proofs[index],
    })),
    objectivesSha256: releaseInputs.bootstrap.objectivesSha256,
    validatorRoot: validatorCatalog.root,
    validators: validators.map((entry, index) => ({
      ...entry,
      proof: validatorCatalog.proofs[index],
    })),
  };
}

export function artifactBytecodeEvidence() {
  return Object.fromEntries(
    [...new Set(Object.values(CONTRACT_TYPES))].map((name) => {
      const compiled = artifact(name);
      return [
        name,
        {
          sourceName: compiled.sourceName,
          creationBytecodeHash: keccak256(compiled.bytecode),
          runtimeBytecodeHash: keccak256(compiled.deployedBytecode),
          runtimeBytes: (compiled.deployedBytecode.length - 2) / 2,
        },
      ];
    }),
  );
}

export function serializeIssue(issue) {
  return {
    ...issue,
    candidateBudgetCap: issue.candidateBudgetCap.toString(),
    totalBudgetCap: issue.totalBudgetCap.toString(),
  };
}
