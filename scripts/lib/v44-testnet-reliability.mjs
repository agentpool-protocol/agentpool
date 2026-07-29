import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  recoverMessageAddress,
  toBytes,
} from "viem";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  assertTrackedTreeClean,
  currentGitCommit,
  loadAndValidateConfig,
  merkleCatalog,
  readJson,
  sha256File,
  sha256Json,
} from "./v44-mainnet.mjs";
import {
  verifyV44ReleaseEvidenceFile,
} from "../generate-v44-release-evidence.mjs";

export const TESTNET_CHAIN_ID = 84532;
export const TARGET_CHAIN_ID = 8453;
export const RELIABILITY_SCHEMA =
  "agentpool.mainnet.v44.public-testnet-reliability/v1";
export const POLICY_SCHEMA =
  "agentpool.testnet.v44.reliability-policy/v1";
export const DEPLOYMENT_SCHEMA =
  "agentpool.testnet.v44.deployment/v1";
export const OBSERVATION_SCHEMA =
  "agentpool.testnet.v44.observations/v1";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const JOB_STATE = Object.freeze({
  SETTLED: 4,
  REJECTED: 5,
  REFUNDED: 6,
  EXPIRED: 7,
});
const FUNDING = Object.freeze({
  EXTERNAL: 1,
  CORE: 2,
  EVOLUTION: 3,
});
const SEMANTICS = new Set([
  "BOOTSTRAP_SETTLEMENT",
  "SYSTEM_SETTLEMENT",
  "EXTERNAL_SETTLEMENT",
  "JOB_CLOSED_EXPIRED",
  "JOB_CLOSED_NO_QUORUM_REFUND",
  "JOB_CLOSED_REJECTED",
  "FINALIZED_ISSUE_REPLAY",
  "DUPLICATE_SETTLEMENT",
  "EMISSION_CAP_EXCEEDED",
  "TRANSITION_APPROVAL",
  "MATURE_APPROVAL",
  "RELEASE_RECOMMENDATION",
]);

function exactKeys(value, expected, label) {
  const actualKeys = Object.keys(value ?? {}).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`V44_TESTNET_${label}_KEYS_INVALID`);
  }
}

function validatorLeaf(address, operatorGroup) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [getAddress(address), operatorGroup],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [inner]),
  );
}

function requireInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`V44_TESTNET_POLICY_INVALID:${label}`);
  }
}

function requireIso(value, label) {
  if (
    typeof value !== "string" ||
    !ISO_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`V44_TESTNET_${label}_INVALID`);
  }
  return Date.parse(value);
}

function canonicalObservationBody(observations) {
  const body = structuredClone(observations);
  delete body.attestations;
  return body;
}

export function observationAttestationMessage(observations) {
  return [
    "AgentPool v4.4 public testnet observations",
    sha256Json(canonicalObservationBody(observations)),
  ].join("\n");
}

export function loadReliabilityPolicy(
  filePath = path.join(
    ROOT,
    "mainnet-v44-testnet-reliability-policy.json",
  ),
) {
  const policy = readJson(filePath);
  if (
    policy.schema !== POLICY_SCHEMA ||
    policy.release !== VERSION ||
    policy.observedChainId !== TESTNET_CHAIN_ID ||
    policy.targetChainId !== TARGET_CHAIN_ID
  ) {
    throw new Error("V44_TESTNET_POLICY_IDENTITY_INVALID");
  }
  for (const [label, value, minimum] of [
    ["minimumObservationDays", policy.minimumObservationDays, 90],
    ["maximumEvidenceAgeHours", policy.maximumEvidenceAgeHours, 1],
    ["maximumIndexerLagBlocks", policy.maximumIndexerLagBlocks, 0],
    ["minimumVerifiedTransactions", policy.minimumVerifiedTransactions, 1],
    ["minimumContributingAgents", policy.minimumContributingAgents, 5],
    [
      "minimumContributingOperatorGroups",
      policy.minimumContributingOperatorGroups,
      3,
    ],
    ["minimumIndependentObservers", policy.minimumIndependentObservers, 2],
    [
      "minimumIndependentObserverGroups",
      policy.minimumIndependentObserverGroups,
      2,
    ],
    [
      "maximumOpenCriticalIncidents",
      policy.maximumOpenCriticalIncidents,
      0,
    ],
  ]) {
    requireInteger(value, minimum, label);
  }
  const categoryEntries = Object.entries(policy.categories ?? {});
  if (categoryEntries.length === 0) {
    throw new Error("V44_TESTNET_POLICY_CATEGORIES_EMPTY");
  }
  let requiredTransactions = 0;
  for (const [category, rule] of categoryEntries) {
    requireInteger(rule?.minimum, 1, `categories.${category}.minimum`);
    requiredTransactions += rule.minimum;
    if (
      !["success", "reverted"].includes(rule.transactionStatus) ||
      !(rule.contractKey in CONTRACT_TYPES) ||
      !Array.isArray(rule.requiredEvents) ||
      typeof rule.functionName !== "string" ||
      !SEMANTICS.has(rule.semantic)
    ) {
      throw new Error(`V44_TESTNET_POLICY_CATEGORY_INVALID:${category}`);
    }
    const contractAbi = artifact(CONTRACT_TYPES[rule.contractKey]).abi;
    const errorContractKey = rule.errorContractKey ?? rule.contractKey;
    if (!(errorContractKey in CONTRACT_TYPES)) {
      throw new Error(`V44_TESTNET_POLICY_ERROR_CONTRACT_INVALID:${category}`);
    }
    const errorContractAbi = artifact(
      CONTRACT_TYPES[errorContractKey],
    ).abi;
    if (
      !contractAbi.some(
        (entry) =>
          entry.type === "function" &&
          entry.name === rule.functionName,
      ) ||
      (
        rule.transactionStatus === "reverted" &&
        (
          typeof rule.expectedRevertError !== "string" ||
          !errorContractAbi.some(
            (entry) =>
              entry.type === "error" &&
              entry.name === rule.expectedRevertError,
          )
        )
      )
    ) {
      throw new Error(`V44_TESTNET_POLICY_FUNCTION_INVALID:${category}`);
    }
    for (const event of rule.requiredEvents) {
      if (
        !(event?.contractKey in CONTRACT_TYPES) ||
        typeof event.signature !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/u.test(event.signature)
      ) {
        throw new Error(`V44_TESTNET_POLICY_EVENT_INVALID:${category}`);
      }
    }
  }
  if (policy.minimumVerifiedTransactions < requiredTransactions) {
    throw new Error("V44_TESTNET_POLICY_TRANSACTION_FLOOR_TOO_LOW");
  }
  if (
    !Array.isArray(policy.criticalInvariants) ||
    policy.criticalInvariants.length < 7 ||
    new Set(policy.criticalInvariants).size !== policy.criticalInvariants.length
  ) {
    throw new Error("V44_TESTNET_POLICY_INVARIANTS_INVALID");
  }
  return {
    policy,
    policyPath: path.resolve(filePath),
    policySha256: sha256File(filePath),
  };
}

export function validateTestnetDeployment(deployment, sourceEvidence) {
  if (
    deployment?.schema !== DEPLOYMENT_SCHEMA ||
    deployment.chainId !== TESTNET_CHAIN_ID ||
    deployment.network !== "Base Sepolia" ||
    deployment.release !== VERSION
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_IDENTITY_INVALID");
  }
  if (
    !/^[0-9a-f]{40}$/u.test(deployment.sourceCommit ?? "") ||
    deployment.sourceCommit !== sourceEvidence?.sourceCommit ||
    !SHA256_PATTERN.test(deployment.sourceEvidenceSha256 ?? "") ||
    deployment.sourceEvidenceSha256 !== sourceEvidence?.evidenceSha256 ||
    deployment.financeInvariantHash !== sourceEvidence?.financeInvariantHash ||
    deployment.configSha256 !== sourceEvidence?.configSha256
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_SOURCE_INVALID");
  }
  const contractKeys = Object.keys(CONTRACT_TYPES);
  exactKeys(deployment.contracts, contractKeys, "DEPLOYMENT_CONTRACT");
  exactKeys(
    deployment.deployedCodeHashes,
    contractKeys,
    "DEPLOYMENT_CODE_HASH",
  );
  exactKeys(
    deployment.deploymentTransactions,
    contractKeys,
    "DEPLOYMENT_TRANSACTION",
  );
  exactKeys(
    deployment.creationInputHashes,
    contractKeys,
    "DEPLOYMENT_INPUT_HASH",
  );
  exactKeys(
    deployment.artifactTypes,
    contractKeys,
    "DEPLOYMENT_ARTIFACT_TYPE",
  );
  const artifactTypes = [...new Set(Object.values(CONTRACT_TYPES))];
  exactKeys(
    deployment.artifactCreationBytecodeHashes,
    artifactTypes,
    "DEPLOYMENT_ARTIFACT_HASH",
  );
  if (!isAddress(deployment.deployer)) {
    throw new Error("V44_TESTNET_DEPLOYMENT_DEPLOYER_INVALID");
  }
  const seenAddresses = new Set();
  for (const key of contractKeys) {
    const address = deployment.contracts[key];
    const codeHash = deployment.deployedCodeHashes[key];
    const transactionHash = deployment.deploymentTransactions[key];
    const creationInputHash = deployment.creationInputHashes[key];
    const artifactType = deployment.artifactTypes[key];
    if (
      !isAddress(address) ||
      !HASH_PATTERN.test(codeHash ?? "") ||
      !HASH_PATTERN.test(transactionHash ?? "") ||
      !HASH_PATTERN.test(creationInputHash ?? "") ||
      artifactType !== CONTRACT_TYPES[key]
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_CONTRACT_INVALID:${key}`);
    }
    const normalizedAddress = getAddress(address).toLowerCase();
    if (seenAddresses.has(normalizedAddress)) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_ADDRESS_REUSED:${key}`);
    }
    seenAddresses.add(normalizedAddress);
  }
  for (const type of artifactTypes) {
    const declared = deployment.artifactCreationBytecodeHashes[type];
    const sourceHash = sourceEvidence?.artifacts?.[type]?.creationBytecodeHash;
    if (
      !HASH_PATTERN.test(declared ?? "") ||
      declared.toLowerCase() !== sourceHash?.toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_ARTIFACT_INVALID:${type}`);
    }
  }
  requireInteger(deployment.deploymentBlock, 1, "deploymentBlock");
  requireInteger(deployment.genesisStart, 1, "genesisStart");
  for (const [label, value] of [
    ["GENESIS_RELEASE", deployment.genesisRelease],
    ["GENESIS_MODULE_HASH", deployment.genesisModuleHash],
    ["GENESIS_MANIFEST_HASH", deployment.genesisManifestHash],
    ["BOOTSTRAP_ROOT", deployment.bootstrapRoot],
    ["DYNAMIC_VALIDATOR_ROOT", deployment.dynamicValidatorRoot],
    ["BOOTSTRAP_VERIFIER_CODEHASH", deployment.bootstrapVerifierCodehash],
  ]) {
    if (!HASH_PATTERN.test(value ?? "") || /^0x0{64}$/u.test(value)) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_${label}_INVALID`);
    }
  }
  const validators = deployment.bootstrap?.validators;
  if (!Array.isArray(validators) || validators.length < 3) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INVALID");
  }
  const observerAddresses = new Set();
  const observerGroups = new Set();
  const leaves = validators.map((entry) => {
    if (
      !isAddress(entry?.address) ||
      !HASH_PATTERN.test(entry?.group ?? "") ||
      entry.group.toLowerCase() === ZERO_BYTES32
    ) {
      throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INVALID");
    }
    const address = getAddress(entry.address).toLowerCase();
    const group = entry.group.toLowerCase();
    if (
      observerAddresses.has(address) ||
      observerGroups.has(group)
    ) {
      throw new Error("V44_TESTNET_OBSERVER_REGISTRY_NOT_INDEPENDENT");
    }
    observerAddresses.add(address);
    observerGroups.add(group);
    return validatorLeaf(address, group);
  });
  if (
    merkleCatalog(leaves).root.toLowerCase() !==
    deployment.dynamicValidatorRoot.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_ROOT_MISMATCH");
  }
  const unsigned = structuredClone(deployment);
  delete unsigned.manifestSha256;
  if (
    !SHA256_PATTERN.test(deployment.manifestSha256 ?? "") ||
    sha256Json(unsigned) !== deployment.manifestSha256
  ) {
    throw new Error("V44_TESTNET_DEPLOYMENT_SELF_HASH_INVALID");
  }
  return deployment;
}

export function validateObservations(
  observations,
  { policy, deployment },
) {
  if (
    observations?.schema !== OBSERVATION_SCHEMA ||
    observations.observedChainId !== TESTNET_CHAIN_ID ||
    observations.release !== VERSION ||
    observations.sourceCommit !== deployment.sourceCommit ||
    observations.deploymentManifestSha256 !== deployment.manifestSha256
  ) {
    throw new Error("V44_TESTNET_OBSERVATIONS_IDENTITY_INVALID");
  }
  const startedAt = requireIso(
    observations.startedAt,
    "OBSERVATION_START",
  );
  const endedAt = requireIso(observations.endedAt, "OBSERVATION_END");
  if (endedAt <= startedAt) {
    throw new Error("V44_TESTNET_OBSERVATION_WINDOW_INVALID");
  }
  if (
    !Array.isArray(observations.observations) ||
    !Array.isArray(observations.incidents) ||
    !Array.isArray(observations.attestations)
  ) {
    throw new Error("V44_TESTNET_OBSERVATIONS_SHAPE_INVALID");
  }
  const seenTransactions = new Set();
  for (const entry of observations.observations) {
    const rule = policy.categories?.[entry?.category];
    if (
      !rule ||
      !HASH_PATTERN.test(entry.txHash ?? "") ||
      entry.contractKey !== rule.contractKey ||
      entry.expectedStatus !== rule.transactionStatus
    ) {
      throw new Error("V44_TESTNET_OBSERVATION_ENTRY_INVALID");
    }
    const normalizedHash = entry.txHash.toLowerCase();
    if (seenTransactions.has(normalizedHash)) {
      throw new Error("V44_TESTNET_OBSERVATION_TX_REUSED");
    }
    seenTransactions.add(normalizedHash);
  }
  return { observations, startedAt, endedAt };
}

export async function verifyObservationAttestations(
  observations,
  policy,
  deployment,
) {
  const message = observationAttestationMessage(observations);
  const addresses = new Set();
  const groups = new Set();
  const observerRegistry = new Map(
    (deployment?.bootstrap?.validators ?? []).map((entry) => [
      getAddress(entry.address).toLowerCase(),
      entry.group.toLowerCase(),
    ]),
  );
  if (observerRegistry.size < policy.minimumIndependentObservers) {
    throw new Error("V44_TESTNET_OBSERVER_REGISTRY_INSUFFICIENT");
  }
  for (const attestation of observations.attestations) {
    if (
      !isAddress(attestation?.observer) ||
      !HASH_PATTERN.test(attestation?.operatorGroup ?? "") ||
      typeof attestation.signature !== "string"
    ) {
      throw new Error("V44_TESTNET_OBSERVER_ATTESTATION_INVALID");
    }
    const recovered = await recoverMessageAddress({
      message,
      signature: attestation.signature,
    });
    if (
      recovered.toLowerCase() !==
      getAddress(attestation.observer).toLowerCase()
    ) {
      throw new Error("V44_TESTNET_OBSERVER_SIGNATURE_INVALID");
    }
    const recoveredAddress = recovered.toLowerCase();
    const registeredGroup = observerRegistry.get(recoveredAddress);
    if (
      !registeredGroup ||
      registeredGroup !== attestation.operatorGroup.toLowerCase()
    ) {
      throw new Error("V44_TESTNET_OBSERVER_NOT_REGISTERED");
    }
    addresses.add(recoveredAddress);
    groups.add(registeredGroup);
  }
  return {
    verified: true,
    observerCount: addresses.size,
    observerGroupCount: groups.size,
    meetsIndependence:
      addresses.size >= policy.minimumIndependentObservers &&
      groups.size >= policy.minimumIndependentObserverGroups,
  };
}

function eventTopic(signature) {
  return keccak256(toBytes(signature)).toLowerCase();
}

function indexedAddress(topic) {
  if (!HASH_PATTERN.test(topic ?? "")) return null;
  return getAddress(`0x${topic.slice(-40)}`);
}

export function canonicalDeploymentArguments({
  deployment,
  config,
}) {
  const proposalBond = parseEther(config.consensus.proposalBondApool);
  const argumentsByKey = {
    token: [deployment.deployer],
    settlementRouter: [deployment.deployer],
    releaseRegistry: [
      deployment.genesisRelease,
      deployment.genesisModuleHash,
      deployment.genesisManifestHash,
      deployment.deployer,
    ],
    capacityRegistry: [deployment.deployer],
    userEscrow: [
      deployment.contracts.token,
      deployment.deployer,
    ],
    coreEpochVault: [
      deployment.contracts.token,
      keccak256(toBytes("CORE")),
      BigInt(deployment.genesisStart),
      parseEther(config.emission.coreWeeklyCapApool),
      parseEther(config.emission.coreLifetimeCapApool),
      deployment.deployer,
    ],
    evolutionEpochVault: [
      deployment.contracts.token,
      keccak256(toBytes("EVOLUTION")),
      BigInt(deployment.genesisStart),
      parseEther(config.emission.evolutionWeeklyCapApool),
      parseEther(config.emission.evolutionLifetimeCapApool),
      deployment.deployer,
    ],
    contributionLedger: [
      BigInt(deployment.genesisStart),
      deployment.contracts.settlementRouter,
      deployment.deployer,
    ],
    proofRegistry: [
      deployment.contracts.contributionLedger,
      deployment.deployer,
    ],
    evolutionConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.releaseRegistry,
      deployment.financeInvariantHash,
      deployment.genesisRelease,
      proposalBond,
    ],
    objectiveVerifier: [],
    systemIssueGate: [
      deployment.bootstrapRoot,
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.deployer,
      deployment.bootstrapVerifierCodehash,
      deployment.dynamicValidatorRoot,
      parseEther(config.dynamicIssues.candidateBudgetCapApool),
      parseEther(config.dynamicIssues.issueBudgetCapApool),
      config.dynamicIssues.maxCandidates,
      config.dynamicIssues.maxLifetimeSeconds,
      parseEther(config.dynamicIssues.candidateAdmissionBondApool),
    ],
    transitionIssueConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.systemIssueGate,
      proposalBond,
    ],
    issueConsensus: [
      deployment.contracts.token,
      deployment.contracts.contributionLedger,
      deployment.contracts.systemIssueGate,
      proposalBond,
    ],
    taskMarket: [
      deployment.contracts.token,
      deployment.contracts.userEscrow,
      deployment.contracts.coreEpochVault,
      deployment.contracts.evolutionEpochVault,
      deployment.contracts.contributionLedger,
      deployment.contracts.releaseRegistry,
      deployment.contracts.capacityRegistry,
      deployment.contracts.proofRegistry,
      deployment.contracts.settlementRouter,
      deployment.contracts.systemIssueGate,
      deployment.financeInvariantHash,
    ],
  };
  exactKeys(
    argumentsByKey,
    Object.keys(CONTRACT_TYPES),
    "CANONICAL_DEPLOYMENT_ARGUMENT",
  );
  return argumentsByKey;
}

export function canonicalCreationInput({
  key,
  deployment,
  config,
}) {
  const type = CONTRACT_TYPES[key];
  if (!type) {
    throw new Error(`V44_TESTNET_DEPLOYMENT_KEY_INVALID:${key}`);
  }
  const compiled = artifact(type);
  const argumentsByKey = canonicalDeploymentArguments({
    deployment,
    config,
  });
  return encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: argumentsByKey[key],
  });
}

export function assertCanonicalCreationInput({
  key,
  deployment,
  config,
  input,
}) {
  const expected = canonicalCreationInput({ key, deployment, config });
  if (
    typeof input !== "string" ||
    input.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(
      `V44_TESTNET_DEPLOYMENT_CONSTRUCTOR_INVALID:${key}`,
    );
  }
  return expected;
}

function resultField(result, name, index) {
  return result?.[name] ?? result?.[index];
}

function decodedArgument(decoded, index) {
  if (!Array.isArray(decoded?.args)) {
    throw new Error("V44_TESTNET_TRANSACTION_ARGUMENTS_INVALID");
  }
  return decoded.args[index];
}

function matchingDecodedEvents({
  receipt,
  deployment,
  contractKey,
  eventName,
}) {
  const address = deployment.contracts[contractKey].toLowerCase();
  const abi = artifact(CONTRACT_TYPES[contractKey]).abi;
  const decoded = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    try {
      const event = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (event.eventName === eventName) decoded.push(event);
    } catch {
      // Logs from other events on the same contract are intentionally skipped.
    }
  }
  return decoded;
}

function errorSelector(errorName) {
  return keccak256(toBytes(`${errorName}()`)).slice(0, 10).toLowerCase();
}

function findRevertData(value, seen = new Set()) {
  if (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{8,}$/u.test(value)
  ) {
    return value.toLowerCase();
  }
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of ["data", "cause", "error", "details", "body"]) {
    const found = findRevertData(value[key], seen);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    const found = findRevertData(nested, seen);
    if (found) return found;
  }
  return null;
}

async function requireReplayError({
  client,
  transaction,
  receipt,
  expectedError,
}) {
  if (receipt.blockNumber === 0n) {
    throw new Error("V44_TESTNET_REVERT_REPLAY_BLOCK_INVALID");
  }
  let replaySucceeded = false;
  try {
    await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.input,
      // A reverted transaction leaves no state, but later transactions in the
      // same block can. Replaying against the prior block proves that the
      // claimed failure condition existed before the evidence transaction.
      blockNumber: receipt.blockNumber - 1n,
    });
    replaySucceeded = true;
  } catch (error) {
    const revertData = findRevertData(error);
    if (
      !revertData ||
      revertData.slice(0, 10) !== errorSelector(expectedError)
    ) {
      throw new Error(
        `V44_TESTNET_REVERT_REASON_INVALID:${expectedError}`,
      );
    }
  }
  if (replaySucceeded) {
    throw new Error("V44_TESTNET_REVERT_REPLAY_SUCCEEDED");
  }
}

export function assertClosedJobSemantic({
  category,
  decodedFunction,
  receipt,
  deployment,
}) {
  const jobId = decodedArgument(decodedFunction, 0);
  const expectedState = {
    REFUND_COMPLETED: JOB_STATE.EXPIRED,
    NO_QUORUM_REFUND: JOB_STATE.REFUNDED,
    REJECTION_PRESERVED: JOB_STATE.REJECTED,
  }[category];
  if (expectedState === undefined) {
    throw new Error(`V44_TESTNET_JOB_CLOSE_CATEGORY_INVALID:${category}`);
  }
  const closes = matchingDecodedEvents({
    receipt,
    deployment,
    contractKey: "taskMarket",
    eventName: "JobClosed",
  }).filter(
    (event) =>
      event.args.jobId.toLowerCase() === jobId.toLowerCase() &&
      Number(event.args.state) === expectedState,
  );
  if (closes.length !== 1) {
    throw new Error(`V44_TESTNET_JOB_CLOSE_STATE_INVALID:${category}`);
  }
  return { jobId, expectedState };
}

export async function verifyObservationSemantic({
  client,
  deployment,
  entry,
  rule,
  receipt,
  transaction,
  read,
}) {
  const abi = artifact(CONTRACT_TYPES[rule.contractKey]).abi;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi, data: transaction.input });
  } catch {
    throw new Error(
      `V44_TESTNET_FUNCTION_DECODE_INVALID:${entry.category}`,
    );
  }
  if (decoded.functionName !== rule.functionName) {
    throw new Error(
      `V44_TESTNET_FUNCTION_MISMATCH:${entry.category}`,
    );
  }

  if (rule.transactionStatus === "reverted") {
    await requireReplayError({
      client,
      transaction,
      receipt,
      expectedError: rule.expectedRevertError,
    });
  }
  const semanticBlock =
    rule.transactionStatus === "reverted"
      ? receipt.blockNumber - 1n
      : receipt.blockNumber;

  if (
    [
      "BOOTSTRAP_SETTLEMENT",
      "SYSTEM_SETTLEMENT",
      "EXTERNAL_SETTLEMENT",
    ].includes(rule.semantic)
  ) {
    const jobId = decodedArgument(decoded, 0);
    const milestoneIndex = decodedArgument(decoded, 1);
    const job = await read(
      "taskMarket",
      "jobs",
      [jobId],
      receipt.blockNumber,
    );
    const funding = Number(resultField(job, "funding", 1));
    const governanceEligible = await read(
      "taskMarket",
      "jobGovernanceEligible",
      [jobId],
      receipt.blockNumber,
    );
    const settlementMatched = matchingDecodedEvents({
      receipt,
      deployment,
      contractKey: "taskMarket",
      eventName: "MilestoneSettled",
    }).some(
      (event) =>
        event.args.jobId.toLowerCase() === jobId.toLowerCase() &&
        Number(event.args.milestone) === Number(milestoneIndex),
    );
    const correctLane =
      (
        rule.semantic === "BOOTSTRAP_SETTLEMENT" &&
        funding === FUNDING.EVOLUTION &&
        governanceEligible === false
      ) ||
      (
        rule.semantic === "SYSTEM_SETTLEMENT" &&
        [FUNDING.CORE, FUNDING.EVOLUTION].includes(funding) &&
        governanceEligible === true
      ) ||
      (
        rule.semantic === "EXTERNAL_SETTLEMENT" &&
        funding === FUNDING.EXTERNAL
      );
    if (!settlementMatched || !correctLane) {
      throw new Error(
        `V44_TESTNET_SETTLEMENT_SEMANTIC_INVALID:${entry.category}`,
      );
    }
    return;
  }

  if (
    [
      "JOB_CLOSED_EXPIRED",
      "JOB_CLOSED_NO_QUORUM_REFUND",
      "JOB_CLOSED_REJECTED",
    ].includes(rule.semantic)
  ) {
    assertClosedJobSemantic({
      category: entry.category,
      decodedFunction: decoded,
      receipt,
      deployment,
    });
    return;
  }

  if (rule.semantic === "DUPLICATE_SETTLEMENT") {
    const jobId = decodedArgument(decoded, 0);
    const milestoneIndex = decodedArgument(decoded, 1);
    const [job, milestone] = await Promise.all([
      read("taskMarket", "jobs", [jobId], receipt.blockNumber),
      read(
        "taskMarket",
        "milestones",
        [jobId, milestoneIndex],
        receipt.blockNumber,
      ),
    ]);
    if (
      Number(resultField(job, "state", 2)) !== JOB_STATE.SETTLED ||
      Number(resultField(milestone, "state", 16)) !== 4
    ) {
      throw new Error("V44_TESTNET_DUPLICATE_SETTLEMENT_STATE_INVALID");
    }
    return;
  }

  if (rule.semantic === "FINALIZED_ISSUE_REPLAY") {
    const issue = decodedArgument(decoded, 4);
    const issueId = resultField(issue, "issueId", 0);
    const [group, termsHash, usage] = await Promise.all([
      read(
        "contributionLedger",
        "operatorGroup",
        [transaction.from],
        semanticBlock,
      ),
      read("systemIssueGate", "hashIssue", [issue], semanticBlock),
      read("systemIssueGate", "usage", [issueId], semanticBlock),
    ]);
    const usageTermsHash = resultField(usage, "termsHash", 0);
    const finalized =
      group !== ZERO_BYTES32 &&
      usageTermsHash.toLowerCase() === termsHash.toLowerCase() &&
      (await read(
        "systemIssueGate",
        "candidateFinalized",
        [issueId, group],
        semanticBlock,
      ));
    if (!finalized) {
      throw new Error("V44_TESTNET_ISSUE_REPLAY_STATE_INVALID");
    }
    return;
  }

  if (rule.semantic === "EMISSION_CAP_EXCEEDED") {
    const funding = Number(decodedArgument(decoded, 0));
    const budget = BigInt(decodedArgument(decoded, 1));
    const issue = decodedArgument(decoded, 4);
    const terms = decodedArgument(decoded, 6);
    const requested = terms.reduce(
      (total, term) =>
        total +
        BigInt(resultField(term, "allocation", 6)) +
        BigInt(resultField(term, "keeperFee", 8)),
      0n,
    );
    const vaultKey =
      funding === FUNDING.CORE
        ? "coreEpochVault"
        : funding === FUNDING.EVOLUTION
          ? "evolutionEpochVault"
          : null;
    if (!vaultKey || requested === 0n || budget < requested) {
      throw new Error("V44_TESTNET_CAP_PROBE_INVALID");
    }
    const issueId = resultField(issue, "issueId", 0);
    const candidateBudgetCap = BigInt(
      resultField(issue, "candidateBudgetCap", 7),
    );
    const totalBudgetCap = BigInt(
      resultField(issue, "totalBudgetCap", 8),
    );
    const maxCandidates = Number(resultField(issue, "maxCandidates", 9));
    const termsHash = await read(
      "systemIssueGate",
      "hashIssue",
      [issue],
      semanticBlock,
    );
    const [usage, transitionApproved, matureApproved, group] =
      await Promise.all([
        read("systemIssueGate", "usage", [issueId], semanticBlock),
        read(
          "systemIssueGate",
          "transitionApprovedIssueHash",
          [termsHash],
          semanticBlock,
        ),
        read(
          "systemIssueGate",
          "approvedIssueHash",
          [termsHash],
          semanticBlock,
        ),
        read(
          "contributionLedger",
          "operatorGroup",
          [transaction.from],
          semanticBlock,
        ),
      ]);
    const usageTermsHash = resultField(usage, "termsHash", 0);
    const committedBudget = BigInt(
      resultField(usage, "committedBudget", 1),
    );
    const candidates = Number(resultField(usage, "candidates", 2));
    const groupAlreadyUsed =
      group === ZERO_BYTES32
        ? true
        : await read(
            "systemIssueGate",
            "groupUsed",
            [issueId, group],
            semanticBlock,
          );
    if (
      (!transitionApproved && !matureApproved) ||
      (
        usageTermsHash !== ZERO_BYTES32 &&
        usageTermsHash.toLowerCase() !== termsHash.toLowerCase()
      ) ||
      groupAlreadyUsed ||
      requested > candidateBudgetCap ||
      committedBudget + requested > totalBudgetCap ||
      candidates >= maxCandidates
    ) {
      throw new Error("V44_TESTNET_CAP_PROBE_GATE_PRECONDITION_INVALID");
    }
    const epoch = await read(
      vaultKey,
      "currentEpoch",
      [],
      semanticBlock,
    );
    const [
      epochEmitted,
      totalReserved,
      weeklyCap,
      totalEmitted,
      lifetimeCap,
    ] = await Promise.all([
      read(vaultKey, "epochEmitted", [epoch], semanticBlock),
      read(vaultKey, "totalReserved", [], semanticBlock),
      read(vaultKey, "weeklyCap", [], semanticBlock),
      read(vaultKey, "totalEmitted", [], semanticBlock),
      read(vaultKey, "lifetimeCap", [], semanticBlock),
    ]);
    if (
      BigInt(epochEmitted) + BigInt(totalReserved) + requested <=
        BigInt(weeklyCap) &&
      BigInt(totalEmitted) + BigInt(totalReserved) + requested <=
        BigInt(lifetimeCap)
    ) {
      throw new Error("V44_TESTNET_CAP_NOT_EXCEEDED");
    }
  }
}

export async function collectLiveRpcEvidence({
  rpcUrl,
  deployment,
  observations,
  policy,
  verificationBlockNumber,
}) {
  if (typeof rpcUrl !== "string" || rpcUrl.trim().length === 0) {
    throw new Error("V44_TESTNET_RPC_URL_MISSING");
  }
  const client = createPublicClient({
    chain: {
      id: TESTNET_CHAIN_ID,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
  });
  if ((await client.getChainId()) !== TESTNET_CHAIN_ID) {
    throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
  }
  const currentLatestBlock = await client.getBlockNumber();
  if (
    verificationBlockNumber !== undefined &&
    (!Number.isSafeInteger(Number(verificationBlockNumber)) ||
      Number(verificationBlockNumber) <= 0)
  ) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_INVALID");
  }
  const verificationBlock =
    verificationBlockNumber === undefined
      ? currentLatestBlock
      : BigInt(verificationBlockNumber);
  if (verificationBlock > currentLatestBlock) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_IN_FUTURE");
  }
  if (verificationBlock < BigInt(deployment.deploymentBlock)) {
    throw new Error("V44_TESTNET_VERIFICATION_BLOCK_BEFORE_DEPLOYMENT");
  }
  const configEvidence = loadAndValidateConfig();
  if (configEvidence.configSha256 !== deployment.configSha256) {
    throw new Error("V44_TESTNET_LIVE_CONFIG_MISMATCH");
  }
  const expectedGenesisRelease = keccak256(
    encodeAbiParameters(
      [{ type: "bytes20" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        `0x${deployment.sourceCommit}`,
        deployment.genesisModuleHash,
        deployment.genesisManifestHash,
      ],
    ),
  );
  if (
    expectedGenesisRelease.toLowerCase() !==
    deployment.genesisRelease.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_GENESIS_RELEASE_INVALID");
  }
  for (const [key, address] of Object.entries(deployment.contracts)) {
    const type = CONTRACT_TYPES[key];
    const compiled = artifact(type);
    const [code, receipt, transaction] = await Promise.all([
      client.getCode({ address, blockNumber: verificationBlock }),
      client.getTransactionReceipt({
        hash: deployment.deploymentTransactions[key],
      }),
      client.getTransaction({
        hash: deployment.deploymentTransactions[key],
      }),
    ]);
    assertCanonicalCreationInput({
      key,
      deployment,
      config: configEvidence.config,
      input: transaction.input,
    });
    if (
      !code ||
      code === "0x" ||
      keccak256(code).toLowerCase() !==
        deployment.deployedCodeHashes[key].toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_LIVE_CODE_MISMATCH:${key}`);
    }
    if (
      receipt.status !== "success" ||
      receipt.contractAddress?.toLowerCase() !== address.toLowerCase() ||
      transaction.to !== null ||
      transaction.from.toLowerCase() !== deployment.deployer.toLowerCase() ||
      keccak256(transaction.input).toLowerCase() !==
        deployment.creationInputHashes[key].toLowerCase() ||
      keccak256(compiled.bytecode).toLowerCase() !==
        deployment.artifactCreationBytecodeHashes[type].toLowerCase()
    ) {
      throw new Error(`V44_TESTNET_DEPLOYMENT_PROVENANCE_INVALID:${key}`);
    }
  }

  async function read(key, functionName, args = [], blockNumber) {
    return client.readContract({
      address: deployment.contracts[key],
      abi: artifact(CONTRACT_TYPES[key]).abi,
      functionName,
      args,
      blockNumber:
        blockNumber === undefined ? verificationBlock : blockNumber,
    });
  }

  function same(actual, expected) {
    if (typeof actual === "string" && typeof expected === "string") {
      return actual.toLowerCase() === expected.toLowerCase();
    }
    return actual === expected;
  }

  async function requireRead(key, functionName, expected, args = []) {
    const actual = await read(key, functionName, args);
    if (!same(actual, expected)) {
      throw new Error(
        `V44_TESTNET_WIRING_MISMATCH:${key}.${functionName}:${actual}:${expected}`,
      );
    }
  }

  const config = configEvidence.config;
  const proposalBond = parseEther(config.consensus.proposalBondApool);
  const wiringChecks = [
    ["token", "configurationAuthority", ZERO_ADDRESS],
    ["token", "coreEpochVault", deployment.contracts.coreEpochVault],
    [
      "token",
      "evolutionEpochVault",
      deployment.contracts.evolutionEpochVault,
    ],
    ["token", "MAX_SUPPLY", parseEther(config.token.maxSupplyApool)],
    ["userEscrow", "configurationAuthority", ZERO_ADDRESS],
    ["userEscrow", "token", deployment.contracts.token],
    ["userEscrow", "market", deployment.contracts.taskMarket],
    ["coreEpochVault", "configurationAuthority", ZERO_ADDRESS],
    ["coreEpochVault", "token", deployment.contracts.token],
    ["coreEpochVault", "market", deployment.contracts.taskMarket],
    ["coreEpochVault", "genesisStart", BigInt(deployment.genesisStart)],
    [
      "coreEpochVault",
      "weeklyCap",
      parseEther(config.emission.coreWeeklyCapApool),
    ],
    [
      "coreEpochVault",
      "lifetimeCap",
      parseEther(config.emission.coreLifetimeCapApool),
    ],
    ["evolutionEpochVault", "configurationAuthority", ZERO_ADDRESS],
    ["evolutionEpochVault", "token", deployment.contracts.token],
    ["evolutionEpochVault", "market", deployment.contracts.taskMarket],
    ["evolutionEpochVault", "genesisStart", BigInt(deployment.genesisStart)],
    [
      "evolutionEpochVault",
      "weeklyCap",
      parseEther(config.emission.evolutionWeeklyCapApool),
    ],
    [
      "evolutionEpochVault",
      "lifetimeCap",
      parseEther(config.emission.evolutionLifetimeCapApool),
    ],
    ["capacityRegistry", "configurationAuthority", ZERO_ADDRESS],
    ["capacityRegistry", "market", deployment.contracts.taskMarket],
    ["proofRegistry", "configurationAuthority", ZERO_ADDRESS],
    ["proofRegistry", "market", deployment.contracts.taskMarket],
    ["proofRegistry", "ledger", deployment.contracts.contributionLedger],
    ["contributionLedger", "bootstrapAuthority", ZERO_ADDRESS],
    [
      "contributionLedger",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    [
      "contributionLedger",
      "genesisStart",
      BigInt(deployment.genesisStart),
    ],
    [
      "contributionLedger",
      "isActiveSource",
      true,
      [deployment.contracts.settlementRouter],
    ],
    ["releaseRegistry", "configurationAuthority", ZERO_ADDRESS],
    [
      "releaseRegistry",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    ["settlementRouter", "configurationAuthority", ZERO_ADDRESS],
    [
      "settlementRouter",
      "ledger",
      deployment.contracts.contributionLedger,
    ],
    [
      "settlementRouter",
      "consensus",
      deployment.contracts.evolutionConsensus,
    ],
    ["settlementRouter", "market", deployment.contracts.taskMarket],
    ["systemIssueGate", "configurationAuthority", ZERO_ADDRESS],
    ["systemIssueGate", "market", deployment.contracts.taskMarket],
    [
      "systemIssueGate",
      "transitionConsensus",
      deployment.contracts.transitionIssueConsensus,
    ],
    [
      "systemIssueGate",
      "matureConsensus",
      deployment.contracts.issueConsensus,
    ],
    ["systemIssueGate", "bootstrapRoot", deployment.bootstrapRoot],
    [
      "systemIssueGate",
      "dynamicValidatorRoot",
      deployment.dynamicValidatorRoot,
    ],
    [
      "systemIssueGate",
      "dynamicVerifierCodehash",
      deployment.bootstrapVerifierCodehash,
    ],
    [
      "systemIssueGate",
      "dynamicCandidateBudgetCap",
      parseEther(config.dynamicIssues.candidateBudgetCapApool),
    ],
    [
      "systemIssueGate",
      "dynamicIssueBudgetCap",
      parseEther(config.dynamicIssues.issueBudgetCapApool),
    ],
    [
      "systemIssueGate",
      "dynamicCandidateBond",
      parseEther(config.dynamicIssues.candidateAdmissionBondApool),
    ],
    [
      "transitionIssueConsensus",
      "validatorRoot",
      deployment.dynamicValidatorRoot,
    ],
    ["transitionIssueConsensus", "minimumBond", proposalBond],
    ["issueConsensus", "minimumBond", proposalBond],
    ["evolutionConsensus", "minimumProposalBond", proposalBond],
    [
      "evolutionConsensus",
      "financeInvariantHash",
      deployment.financeInvariantHash,
    ],
    ["taskMarket", "token", deployment.contracts.token],
    ["taskMarket", "userEscrow", deployment.contracts.userEscrow],
    ["taskMarket", "coreEpochVault", deployment.contracts.coreEpochVault],
    [
      "taskMarket",
      "evolutionEpochVault",
      deployment.contracts.evolutionEpochVault,
    ],
    [
      "taskMarket",
      "contributionLedger",
      deployment.contracts.contributionLedger,
    ],
    ["taskMarket", "releaseRegistry", deployment.contracts.releaseRegistry],
    ["taskMarket", "capacityRegistry", deployment.contracts.capacityRegistry],
    ["taskMarket", "proofRegistry", deployment.contracts.proofRegistry],
    [
      "taskMarket",
      "settlementRouter",
      deployment.contracts.settlementRouter,
    ],
    ["taskMarket", "systemIssueGate", deployment.contracts.systemIssueGate],
    [
      "taskMarket",
      "financeInvariantHash",
      deployment.financeInvariantHash,
    ],
  ];
  for (const [key, functionName, expected, args = []] of wiringChecks) {
    await requireRead(key, functionName, expected, args);
  }
  const verifierCode = await client.getCode({
    address: deployment.contracts.objectiveVerifier,
    blockNumber: verificationBlock,
  });
  if (
    !verifierCode ||
    verifierCode === "0x" ||
    keccak256(verifierCode).toLowerCase() !==
      deployment.bootstrapVerifierCodehash.toLowerCase()
  ) {
    throw new Error("V44_TESTNET_VERIFIER_CODEHASH_MISMATCH");
  }

  const contributors = new Set();
  const blocks = new Set();
  let latestObservedBlock = 0n;
  let earliestObservedTimestamp = Number.POSITIVE_INFINITY;
  let latestObservedTimestamp = 0;
  for (const entry of observations.observations) {
    const rule = policy.categories[entry.category];
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: entry.txHash }),
      client.getTransaction({ hash: entry.txHash }),
    ]);
    const expectedStatus =
      rule.transactionStatus === "success" ? "success" : "reverted";
    if (
      receipt.status !== expectedStatus ||
      transaction.to?.toLowerCase() !==
        deployment.contracts[rule.contractKey].toLowerCase() ||
      receipt.blockNumber < BigInt(deployment.deploymentBlock)
    ) {
      throw new Error(`V44_TESTNET_RECEIPT_INVALID:${entry.txHash}`);
    }
    await verifyObservationSemantic({
      client,
      deployment,
      entry,
      rule,
      receipt,
      transaction,
      read,
    });
    for (const expectedEvent of rule.requiredEvents) {
      const address =
        deployment.contracts[expectedEvent.contractKey].toLowerCase();
      const topic = eventTopic(expectedEvent.signature);
      const matchingLogs = receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === address &&
          log.topics[0]?.toLowerCase() === topic,
      );
      if (matchingLogs.length === 0) {
        throw new Error(
          `V44_TESTNET_REQUIRED_EVENT_MISSING:${entry.category}:${expectedEvent.signature}`,
        );
      }
      if (
        expectedEvent.signature.startsWith("OutcomeRecorded(") ||
        expectedEvent.signature.startsWith("PerformanceRecorded(")
      ) {
        for (const log of matchingLogs) {
          const contributor = indexedAddress(log.topics[2]);
          if (contributor) contributors.add(contributor);
        }
      }
    }
    blocks.add(receipt.blockNumber.toString());
    if (receipt.blockNumber > latestObservedBlock) {
      latestObservedBlock = receipt.blockNumber;
    }
  }

  for (const blockNumber of blocks) {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    const timestamp = Number(block.timestamp) * 1000;
    earliestObservedTimestamp = Math.min(earliestObservedTimestamp, timestamp);
    latestObservedTimestamp = Math.max(latestObservedTimestamp, timestamp);
  }
  const operatorGroups = new Set();
  for (const contributor of contributors) {
    const group = await client.readContract({
      address: deployment.contracts.contributionLedger,
      abi: artifact(CONTRACT_TYPES.contributionLedger).abi,
      functionName: "operatorGroup",
      args: [contributor],
      blockNumber: verificationBlock,
    });
    if (HASH_PATTERN.test(group) && !/^0x0{64}$/u.test(group)) {
      operatorGroups.add(group.toLowerCase());
    }
  }
  return {
    liveRpcVerified: true,
    verifiedTransactionCount: observations.observations.length,
    contributingAgents: [...contributors].sort(),
    contributingOperatorGroups: [...operatorGroups].sort(),
    latestObservedBlock: Number(latestObservedBlock),
    earliestObservedTimestamp,
    latestObservedTimestamp,
    latestBlock: Number(verificationBlock),
    indexerLagBlocks: Number(verificationBlock - latestObservedBlock),
  };
}

function blocker(blockers, condition, code) {
  if (!condition) blockers.push(code);
}

export function evaluateReliability({
  policy,
  deployment,
  observations,
  sourceEvidence,
  attestationEvidence,
  rpcEvidence,
  generatedAt = new Date().toISOString(),
  policySha256,
  deploymentFileSha256,
  observationsFileSha256,
  sourceEvidenceFileSha256,
}) {
  const blockers = [];
  const generatedAtMs = Date.parse(generatedAt);
  const declaredStartedAt = Date.parse(observations.startedAt);
  const declaredEndedAt = Date.parse(observations.endedAt);
  const chainStartedAt = rpcEvidence?.earliestObservedTimestamp;
  const chainEndedAt = rpcEvidence?.latestObservedTimestamp;
  const observationDays =
    Number.isFinite(chainStartedAt) && Number.isFinite(chainEndedAt)
      ? (chainEndedAt - chainStartedAt) / DAY_MS
      : 0;
  const evidenceAgeHours = Number.isFinite(chainEndedAt)
    ? (generatedAtMs - chainEndedAt) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  const categoryCounts = Object.fromEntries(
    Object.keys(policy.categories).map((category) => [category, 0]),
  );
  for (const entry of observations.observations) {
    categoryCounts[entry.category] += 1;
  }
  const openCriticalIncidents = observations.incidents.filter(
    (incident) =>
      ["CRITICAL", "HIGH"].includes(incident?.severity) &&
      incident?.status !== "RESOLVED",
  );

  blocker(
    blockers,
    sourceEvidence.sourceCommit === deployment.sourceCommit,
    "SOURCE_COMMIT_MISMATCH",
  );
  blocker(
    blockers,
    rpcEvidence?.liveRpcVerified === true,
    "LIVE_RPC_VERIFICATION_REQUIRED",
  );
  blocker(
    blockers,
    attestationEvidence?.verified === true &&
      attestationEvidence.meetsIndependence === true,
    "INDEPENDENT_OBSERVER_ATTESTATIONS_INSUFFICIENT",
  );
  blocker(
    blockers,
    observationDays >= policy.minimumObservationDays,
    "OBSERVATION_WINDOW_TOO_SHORT",
  );
  blocker(
    blockers,
    Number.isFinite(chainStartedAt) &&
      Number.isFinite(chainEndedAt) &&
      Math.abs(declaredStartedAt - chainStartedAt) <= HOUR_MS &&
      Math.abs(declaredEndedAt - chainEndedAt) <= HOUR_MS,
    "DECLARED_WINDOW_DOES_NOT_MATCH_CHAIN",
  );
  blocker(
    blockers,
    evidenceAgeHours >= 0 &&
      evidenceAgeHours <= policy.maximumEvidenceAgeHours,
    "OBSERVATION_EVIDENCE_STALE",
  );
  blocker(
    blockers,
    rpcEvidence?.verifiedTransactionCount >=
      policy.minimumVerifiedTransactions,
    "VERIFIED_TRANSACTION_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    (rpcEvidence?.contributingAgents?.length ?? 0) >=
      policy.minimumContributingAgents,
    "CONTRIBUTING_AGENT_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    (rpcEvidence?.contributingOperatorGroups?.length ?? 0) >=
      policy.minimumContributingOperatorGroups,
    "CONTRIBUTING_OPERATOR_GROUP_COUNT_TOO_LOW",
  );
  blocker(
    blockers,
    rpcEvidence?.indexerLagBlocks <= policy.maximumIndexerLagBlocks,
    "INDEXER_LAG_TOO_HIGH",
  );
  blocker(
    blockers,
    openCriticalIncidents.length <= policy.maximumOpenCriticalIncidents,
    "UNRESOLVED_CRITICAL_INCIDENTS",
  );
  for (const [category, rule] of Object.entries(policy.categories)) {
    blocker(
      blockers,
      categoryCounts[category] >= rule.minimum,
      `CATEGORY_MINIMUM_NOT_MET:${category}`,
    );
  }

  const eligible = blockers.length === 0;
  return {
    schema: RELIABILITY_SCHEMA,
    release: VERSION,
    sourceCommit: sourceEvidence.sourceCommit,
    targetChainId: TARGET_CHAIN_ID,
    decision: eligible ? "approved" : "blocked",
    observedChainId: TESTNET_CHAIN_ID,
    eligible,
    policySha256,
    deploymentManifestSha256: deployment.manifestSha256,
    deploymentFileSha256,
    observationsFileSha256,
    sourceEvidenceFileSha256,
    liveRpcVerified: rpcEvidence?.liveRpcVerified === true,
    observationWindow: {
      startedAt: observations.startedAt,
      endedAt: observations.endedAt,
      chainStartedAt: Number.isFinite(chainStartedAt)
        ? new Date(chainStartedAt).toISOString()
        : null,
      chainEndedAt: Number.isFinite(chainEndedAt)
        ? new Date(chainEndedAt).toISOString()
        : null,
      days: observationDays,
      evidenceAgeHours,
    },
    counts: {
      verifiedTransactions: rpcEvidence?.verifiedTransactionCount ?? 0,
      contributingAgents: rpcEvidence?.contributingAgents?.length ?? 0,
      contributingOperatorGroups:
        rpcEvidence?.contributingOperatorGroups?.length ?? 0,
      independentObservers: attestationEvidence?.observerCount ?? 0,
      independentObserverGroups:
        attestationEvidence?.observerGroupCount ?? 0,
      openCriticalIncidents: openCriticalIncidents.length,
      categories: categoryCounts,
    },
    chainCursor: {
      latestObservedBlock: rpcEvidence?.latestObservedBlock ?? null,
      latestBlock: rpcEvidence?.latestBlock ?? null,
      indexerLagBlocks: rpcEvidence?.indexerLagBlocks ?? null,
    },
    criticalInvariants: Object.fromEntries(
      policy.criticalInvariants.map((invariant) => [
        invariant,
        openCriticalIncidents.every(
          (incident) => incident?.invariant !== invariant,
        ),
      ]),
    ),
    blockers,
    generatedAt,
  };
}

export function blockedReliabilityReport({
  policyEvidence,
  sourceCommit = currentGitCommit().toLowerCase(),
  blockers,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schema: RELIABILITY_SCHEMA,
    release: VERSION,
    sourceCommit,
    targetChainId: TARGET_CHAIN_ID,
    decision: "blocked",
    observedChainId: TESTNET_CHAIN_ID,
    eligible: false,
    policySha256: policyEvidence.policySha256,
    deploymentManifestSha256: null,
    deploymentFileSha256: null,
    observationsFileSha256: null,
    sourceEvidenceFileSha256: null,
    liveRpcVerified: false,
    observationWindow: null,
    counts: null,
    chainCursor: null,
    criticalInvariants: Object.fromEntries(
      policyEvidence.policy.criticalInvariants.map((invariant) => [
        invariant,
        false,
      ]),
    ),
    blockers: [...new Set(blockers)],
    generatedAt,
  };
}

export async function buildReliabilityReport({
  policyPath,
  deploymentPath,
  observationsPath,
  sourceEvidencePath,
  rpcUrl,
  generatedAt = new Date().toISOString(),
  verificationBlockNumber,
}) {
  const policyEvidence = loadReliabilityPolicy(policyPath);
  const missing = [];
  for (const [label, filePath] of [
    ["V44_TESTNET_DEPLOYMENT_MISSING", deploymentPath],
    ["V44_TESTNET_OBSERVATIONS_MISSING", observationsPath],
    ["V44_SOURCE_EVIDENCE_MISSING", sourceEvidencePath],
  ]) {
    if (!filePath || !fs.existsSync(filePath)) missing.push(label);
  }
  if (!rpcUrl) missing.push("V44_TESTNET_RPC_URL_MISSING");
  if (missing.length > 0) {
    return blockedReliabilityReport({
      policyEvidence,
      blockers: missing,
      generatedAt,
    });
  }

  assertTrackedTreeClean();
  const verifiedSource = verifyV44ReleaseEvidenceFile(sourceEvidencePath);
  const sourceEvidence = verifiedSource.evidence;
  const deployment = validateTestnetDeployment(
    readJson(deploymentPath),
    sourceEvidence,
  );
  const observations = readJson(observationsPath);
  validateObservations(observations, {
    policy: policyEvidence.policy,
    deployment,
  });
  const [attestationEvidence, rpcEvidence] = await Promise.all([
    verifyObservationAttestations(
      observations,
      policyEvidence.policy,
      deployment,
    ),
    collectLiveRpcEvidence({
      rpcUrl,
      deployment,
      observations,
      policy: policyEvidence.policy,
      verificationBlockNumber,
    }),
  ]);
  return evaluateReliability({
    policy: policyEvidence.policy,
    deployment,
    observations,
    sourceEvidence,
    attestationEvidence,
    rpcEvidence,
    generatedAt,
    policySha256: policyEvidence.policySha256,
    deploymentFileSha256: sha256File(deploymentPath),
    observationsFileSha256: sha256File(observationsPath),
    sourceEvidenceFileSha256: verifiedSource.fileSha256,
  });
}

export async function verifyPublicTestnetReliabilityGate({
  gateEvidence,
  env = process.env,
  now = new Date(),
}) {
  const reportPath =
    gateEvidence?.evidencePaths?.publicTestnetReliability;
  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_REPORT_MISSING");
  }
  const report = readJson(reportPath);
  const policyPath = path.join(
    ROOT,
    "mainnet-v44-testnet-reliability-policy.json",
  );
  if (
    env.V44_TESTNET_RELIABILITY_POLICY &&
    path.resolve(env.V44_TESTNET_RELIABILITY_POLICY) !== policyPath
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_POLICY_NOT_CANONICAL");
  }
  const policyEvidence = loadReliabilityPolicy(policyPath);
  const chainEndedAtMs = Date.parse(
    report.observationWindow?.chainEndedAt,
  );
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const gateAgeHours = (nowMs - chainEndedAtMs) / HOUR_MS;
  if (
    !Number.isFinite(chainEndedAtMs) ||
    !Number.isFinite(nowMs) ||
    gateAgeHours < 0 ||
    gateAgeHours > policyEvidence.policy.maximumEvidenceAgeHours
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_STALE");
  }
  const deploymentPath = path.resolve(
    env.V44_TESTNET_DEPLOYMENT_MANIFEST ??
      path.join(ROOT, "deployments", "84532.v44.json"),
  );
  const observationsPath = path.resolve(
    env.V44_TESTNET_OBSERVATIONS ??
      path.join(ROOT, "outputs", "v44-public-testnet-observations.json"),
  );
  const sourceEvidencePath =
    gateEvidence.evidencePaths.finalSourceReproducibility;
  const rpcUrl = env.AGENTPOOL_V44_TESTNET_RPC_URL?.trim();
  const recomputed = await buildReliabilityReport({
    policyPath,
    deploymentPath,
    observationsPath,
    sourceEvidencePath,
    rpcUrl,
    generatedAt: report.generatedAt,
    verificationBlockNumber: report.chainCursor?.latestBlock,
  });
  if (
    recomputed.eligible !== true ||
    recomputed.decision !== "approved" ||
    sha256Json(recomputed) !== sha256File(reportPath)
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_RECOMPUTE_MISMATCH");
  }
  const currentClient = createPublicClient({
    chain: {
      id: TESTNET_CHAIN_ID,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
  });
  if ((await currentClient.getChainId()) !== TESTNET_CHAIN_ID) {
    throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
  }
  const currentHead = await currentClient.getBlockNumber();
  const latestObservedBlock = BigInt(
    recomputed.chainCursor.latestObservedBlock,
  );
  if (
    currentHead < latestObservedBlock ||
    currentHead - latestObservedBlock >
      BigInt(policyEvidence.policy.maximumIndexerLagBlocks)
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_GATE_INDEXER_STALE");
  }
  return recomputed;
}
