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

export const CONTRACT_TYPES = Object.freeze({
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
});

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
    ["bootstrap.funding", config.bootstrap?.funding, 0],
    ["bootstrap.maximumLifetimeSeconds", config.bootstrap?.maximumLifetimeSeconds, 1],
  ]) {
    assertInteger(value, label, minimum);
  }
  if (config.emission.epochSeconds !== 604_800) {
    throw new Error("V44_EPOCH_DURATION_MUST_BE_ONE_WEEK");
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
    config.bootstrap.minimumReveals >
      config.bootstrap.minimumValidatorGroups ||
    config.bootstrap.passScoreBps > 10_000 ||
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
    gates.schema !== "agentpool.mainnet.v44.gates/v1" ||
    gates.chainId !== CHAIN_ID ||
    gates.network !== "base-mainnet" ||
    gates.release !== VERSION
  ) {
    throw new Error("V44_GATES_IDENTITY_INVALID");
  }
  const approved = {};
  for (const [name, gate] of Object.entries(gates.gates ?? {})) {
    if (
      gate?.status !== "approved" ||
      !SHA256_PATTERN.test(gate.evidenceSha256 ?? "")
    ) {
      throw new Error(`V44_GATE_BLOCKED:${name}`);
    }
    const envName = envNameForGate(name);
    const supplied = requireEnv(envName, env).toLowerCase();
    if (!SHA256_PATTERN.test(supplied)) {
      throw new Error(`${envName}_INVALID`);
    }
    if (supplied !== gate.evidenceSha256.toLowerCase()) {
      throw new Error(`V44_GATE_EVIDENCE_MISMATCH:${name}`);
    }
    approved[name] = supplied;
  }
  if (Object.keys(approved).length < 6) {
    throw new Error("V44_GATE_SET_INCOMPLETE");
  }
  return {
    gates,
    gatesPath: resolvedPath,
    gatesSha256: sha256File(resolvedPath),
    approved,
  };
}

export function currentGitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
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
  const bootstrap = {
    proposer: bootstrapProposer,
    validators,
    issueId: requireBytes32("V44_BOOTSTRAP_ISSUE_ID", env),
    capabilityHash: requireBytes32("V44_BOOTSTRAP_CAPABILITY_HASH", env),
    specificationHash: requireBytes32(
      "V44_BOOTSTRAP_SPECIFICATION_HASH",
      env,
    ),
    deliveryHash: requireBytes32("V44_BOOTSTRAP_DELIVERY_HASH", env),
    objectiveProof: requireHex("V44_BOOTSTRAP_OBJECTIVE_PROOF_HEX", env),
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
  const expectedEvidenceHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        releaseInputs.bootstrap.specificationHash,
        releaseInputs.bootstrap.deliveryHash,
        keccak256(releaseInputs.bootstrap.objectiveProof),
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
        { type: "uint16" },
        { type: "uint16" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint16" },
      ],
      [
        getAddress(verifier),
        releaseInputs.bootstrap.capabilityHash,
        releaseInputs.bootstrap.specificationHash,
        expectedEvidenceHash,
        config.bootstrap.minimumReveals,
        config.bootstrap.passScoreBps,
        60,
        60,
        validatorCatalog.root,
        config.bootstrap.minimumValidatorGroups,
      ],
    ),
  );
  const objectiveRoot = keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [objectiveInner]),
  );
  const issue = {
    issueId: releaseInputs.bootstrap.issueId,
    bootstrapProposer: releaseInputs.bootstrap.proposer,
    specificationHash: releaseInputs.bootstrap.specificationHash,
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
