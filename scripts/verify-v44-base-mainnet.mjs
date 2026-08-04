import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toBytes,
} from "viem";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  artifactBytecodeEvidence,
  assertManifestEvidenceClaims,
  assertConfigurationProvenance,
  assertDeploymentProvenance,
  assertTrackedTreeClean,
  buildBootstrapTerms,
  collectReleaseInputs,
  currentGitCommit,
  loadAndValidateConfig,
  loadAndValidateGates,
  redactBootstrapSecrets,
  requireEnv,
  sha256Json,
} from "./lib/v44-mainnet.mjs";
import { resolveV44ChainProfile } from "./lib/v44-chain-profile.mjs";
import {
  validateTestnetDeployment,
  verifyPublicTestnetReliabilityGate,
} from "./lib/v44-testnet-reliability.mjs";
import { verifyV44ReleaseEvidenceFile } from "./generate-v44-release-evidence.mjs";

const profile = resolveV44ChainProfile({
  ...process.env,
  V44_DEPLOYMENT_PROFILE: process.argv.includes("--testnet")
    ? "testnet"
    : "mainnet",
});
const manifestPath =
  process.env.V44_DEPLOYMENT_MANIFEST ??
  profile.manifestPath;
if (!fs.existsSync(manifestPath)) throw new Error("V44_MANIFEST_MISSING");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (
  manifest.schema !== profile.manifestSchema ||
  manifest.chainId !== profile.chainId ||
  manifest.network !== profile.network ||
  (profile.testnetOnly ? manifest.release : manifest.version) !== VERSION ||
  (profile.campaignId && manifest.campaignId !== profile.campaignId)
) {
  throw new Error("V44_MANIFEST_INVALID");
}
assertTrackedTreeClean();
const configEvidence = loadAndValidateConfig();
const gateEvidence = profile.requireReleaseGates
  ? loadAndValidateGates()
  : null;
if (gateEvidence) {
  await verifyPublicTestnetReliabilityGate({ gateEvidence });
}
const sourceEvidencePath = profile.requireReleaseGates
  ? gateEvidence.evidencePaths.finalSourceReproducibility
  : path.resolve(
      ROOT,
      requireEnv("V44_SOURCE_EVIDENCE_FILE"),
    );
const sourceEvidence = verifyV44ReleaseEvidenceFile(
  sourceEvidencePath,
);
const sourceCommit = requireEnv("V44_SOURCE_COMMIT").toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("V44_SOURCE_COMMIT_INVALID");
}
if (sourceCommit !== currentGitCommit().toLowerCase()) {
  throw new Error("V44_SOURCE_COMMIT_NOT_HEAD");
}
const releaseInputs = collectReleaseInputs({
  deployerAddress: manifest.deployer,
  allowPastGenesis: true,
});
if (profile.requireReleaseGates) {
  assertManifestEvidenceClaims({
    manifest,
    gateEvidence,
    sourceEvidence: sourceEvidence.evidence,
    releaseInputs,
    artifacts: artifactBytecodeEvidence(),
  });
} else {
  validateTestnetDeployment(manifest, sourceEvidence.evidence);
}
const rpcUrl = requireEnv(profile.rpcEnvironmentVariable);
const client = createPublicClient({
  chain: profile.chain,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
const actualChainId = await client.getChainId();
if (actualChainId !== profile.chainId) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}

async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}

const checks = [];
function check(name, actual, expected) {
  const passed =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: typeof actual === "bigint" ? actual.toString() : actual,
    expected: typeof expected === "bigint" ? expected.toString() : expected,
  });
}

function exactKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function checkExactKeys(name, value, expected) {
  check(
    name,
    JSON.stringify(exactKeys(value)),
    JSON.stringify([...expected].sort()),
  );
}

const canonicalContractKeys = Object.keys(CONTRACT_TYPES);
checkExactKeys(
  "manifest.contractKeysExact",
  manifest.contracts,
  canonicalContractKeys,
);
checkExactKeys(
  "manifest.deploymentTransactionKeysExact",
  manifest.deploymentTransactions,
  canonicalContractKeys,
);
checkExactKeys(
  "manifest.creationInputHashKeysExact",
  manifest.creationInputHashes,
  canonicalContractKeys,
);
checkExactKeys(
  "manifest.deployedCodeHashKeysExact",
  manifest.deployedCodeHashes,
  canonicalContractKeys,
);
checkExactKeys(
  "manifest.artifactTypeKeysExact",
  manifest.artifactBytecode,
  new Set(Object.values(CONTRACT_TYPES)),
);

const unsignedManifest = { ...manifest };
delete unsignedManifest.manifestSha256;
check(
  "manifest.selfHash",
  sha256Json(unsignedManifest),
  manifest.manifestSha256,
);
check(
  "manifest.configSha256",
  configEvidence.configSha256,
  manifest.configSha256,
);
if (profile.requireReleaseGates) {
  check(
    "manifest.gatesSha256",
    gateEvidence.gatesSha256,
    manifest.gatesSha256,
  );
  check(
    "manifest.approvedGateEvidence",
    sha256Json(manifest.approvedGateEvidence),
    sha256Json(gateEvidence.approved),
  );
} else {
  check("manifest.gatesSha256", manifest.gatesSha256, null);
  check(
    "manifest.approvedGateEvidence",
    manifest.approvedGateEvidence,
    null,
  );
  check(
    "manifest.sourceEvidenceSha256",
    manifest.sourceEvidenceSha256,
    sourceEvidence.evidence.evidenceSha256,
  );
}
check(
  "manifest.sourceEvidenceFileSha256",
  manifest.sourceEvidenceFileSha256,
  sourceEvidence.fileSha256,
);
check(
  "manifest.sourceEvidenceBodySha256",
  manifest.sourceEvidenceBodySha256,
  sourceEvidence.evidence.evidenceSha256,
);
check(
  "manifest.financeInvariantHash",
  configEvidence.financeInvariantHash,
  manifest.financeInvariantHash,
);
check("manifest.sourceCommit", manifest.sourceCommit, sourceCommit);
check(
  "manifest.genesisStart",
  BigInt(manifest.genesisStart),
  BigInt(releaseInputs.genesisStart),
);
check(
  "manifest.genesisRelease",
  manifest.genesisRelease,
  releaseInputs.genesisRelease,
);
check("manifest.deployerHasRuntimeAuthority", manifest.deployerHasRuntimeAuthority, false);

const expectedBootstrap = buildBootstrapTerms({
  config: configEvidence.config,
  releaseInputs,
  verifier: manifest.contracts.objectiveVerifier,
});
const proposalBond = parseEther(
  configEvidence.config.consensus.proposalBondApool,
);
const deploymentArguments = {
  token: [manifest.deployer],
  thresholdAuthority: [
    manifest.thresholdAuthorityOwners,
    manifest.thresholdAuthorityThreshold,
  ],
  policyAnchor: [manifest.contracts.thresholdAuthority],
  maturityAnchor: [manifest.contracts.thresholdAuthority],
  settlementRouter: [manifest.deployer],
  releaseRegistry: [
    manifest.genesisRelease,
    manifest.genesisModuleHash,
    manifest.genesisManifestHash,
    manifest.deployer,
  ],
  capacityRegistry: [manifest.deployer],
  userEscrow: [manifest.contracts.token, manifest.deployer],
  coreEpochVault: [
    manifest.contracts.token,
    keccak256(toBytes("CORE")),
    BigInt(manifest.genesisStart),
    parseEther(configEvidence.config.emission.coreWeeklyCapApool),
    parseEther(configEvidence.config.emission.coreLifetimeCapApool),
    manifest.deployer,
  ],
  evolutionEpochVault: [
    manifest.contracts.token,
    keccak256(toBytes("EVOLUTION")),
    BigInt(manifest.genesisStart),
    parseEther(configEvidence.config.emission.evolutionWeeklyCapApool),
    parseEther(configEvidence.config.emission.evolutionLifetimeCapApool),
    manifest.deployer,
  ],
  contributionLedger: [
    BigInt(manifest.genesisStart),
    manifest.contracts.settlementRouter,
    manifest.deployer,
  ],
  proofRegistry: [
    manifest.contracts.contributionLedger,
    manifest.deployer,
  ],
  evolutionConsensus: [
    manifest.contracts.token,
    manifest.contracts.contributionLedger,
    manifest.contracts.releaseRegistry,
    manifest.financeInvariantHash,
    manifest.genesisRelease,
    proposalBond,
  ],
  objectiveVerifier: [],
  systemIssueGate: [
    expectedBootstrap.issueRoot,
    manifest.contracts.token,
    manifest.contracts.contributionLedger,
    manifest.deployer,
    manifest.bootstrapVerifierCodehash,
    expectedBootstrap.validatorRoot,
    parseEther(
      configEvidence.config.dynamicIssues.candidateBudgetCapApool,
    ),
    parseEther(configEvidence.config.dynamicIssues.issueBudgetCapApool),
    configEvidence.config.dynamicIssues.maxCandidates,
    configEvidence.config.dynamicIssues.maxLifetimeSeconds,
    parseEther(
      configEvidence.config.dynamicIssues.candidateAdmissionBondApool,
    ),
  ],
  transitionIssueConsensus: [
    manifest.contracts.token,
    manifest.contracts.contributionLedger,
    manifest.contracts.systemIssueGate,
    proposalBond,
  ],
  issueConsensus: [
    manifest.contracts.token,
    manifest.contracts.contributionLedger,
    manifest.contracts.systemIssueGate,
    proposalBond,
  ],
  taskMarket: [
    manifest.contracts.token,
    manifest.contracts.userEscrow,
    manifest.contracts.coreEpochVault,
    manifest.contracts.evolutionEpochVault,
    manifest.contracts.contributionLedger,
    manifest.contracts.releaseRegistry,
    manifest.contracts.capacityRegistry,
    manifest.contracts.proofRegistry,
    manifest.contracts.settlementRouter,
    manifest.contracts.systemIssueGate,
    manifest.financeInvariantHash,
    configEvidence.config.dynamicIssues.maxGovernanceMilestones,
  ],
};

const codeHashes = {};
for (const [key, type] of Object.entries(CONTRACT_TYPES)) {
  const deploymentHash = manifest.deploymentTransactions?.[key];
  if (!deploymentHash) {
    throw new Error(`V44_DEPLOYMENT_TX_MISSING:${key}`);
  }
  const compiled = artifact(type);
  const receipt = await client.getTransactionReceipt({
    hash: deploymentHash,
  });
  const transaction = await client.getTransaction({
    hash: deploymentHash,
  });
  const expectedCreationInput = encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: deploymentArguments[key],
  });
  const intent = manifest.transactionIntents?.[`deploy:${key}`];
  if (!intent) throw new Error(`V44_DEPLOYMENT_INTENT_MISSING:${key}`);
  const address = assertDeploymentProvenance({
    key,
    expectedFrom: manifest.deployer,
    expectedInput: expectedCreationInput,
    expectedAddress: manifest.contracts?.[key],
    transaction,
    receipt,
  });
  check(`creationTransaction.to:${key}`, transaction.to, null);
  check(`creationTransaction.intentHash:${key}`, intent.hash, deploymentHash);
  check(`creationTransaction.intentNonce:${key}`, intent.nonce, transaction.nonce);
  check(
    `creationTransaction.intentInputHash:${key}`,
    intent.inputHash,
    keccak256(transaction.input),
  );
  check(
    `creationTransaction.currentArtifact:${key}`,
    transaction.input.toLowerCase() === expectedCreationInput.toLowerCase(),
    true,
  );
  check(
    `creationTransaction.inputHash:${key}`,
    keccak256(transaction.input),
    manifest.creationInputHashes?.[key],
  );
  check(
    `creationArtifact.hash:${key}`,
    keccak256(compiled.bytecode),
    manifest.artifactBytecode?.[type]?.creationBytecodeHash,
  );
  check(
    `creationArtifact.sourceName:${key}`,
    compiled.sourceName,
    manifest.artifactBytecode?.[type]?.sourceName,
  );
  check(
    `creationArtifact.runtimeHash:${key}`,
    keccak256(compiled.deployedBytecode),
    manifest.artifactBytecode?.[type]?.runtimeBytecodeHash,
  );
  check(
    `creationArtifact.runtimeBytes:${key}`,
    (compiled.deployedBytecode.length - 2) / 2,
    manifest.artifactBytecode?.[type]?.runtimeBytes,
  );
  const code = address ? await client.getCode({ address }) : "0x";
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") {
    const bytes = (code.length - 2) / 2;
    check(`codeSize:${key}`, bytes <= 24_576, true);
    codeHashes[key] = keccak256(code);
    check(
      `deployedCodeHash:${key}`,
      codeHashes[key],
      manifest.deployedCodeHashes?.[key],
    );
  }
}
const anchoredActivationAuthority = await read(
  "AgentPoolV44PolicyAnchor",
  manifest.contracts.policyAnchor,
  "ACTIVATION_AUTHORITY",
);
check(
  "policyAnchor.activationAuthority",
  anchoredActivationAuthority,
  manifest.contracts.thresholdAuthority,
);
check(
  "policyAnchor.manifestActivationAuthority",
  manifest.policyActivationAuthority,
  manifest.contracts.thresholdAuthority,
);
const authorityOwners = await read(
  "AgentPoolV44ThresholdAuthority",
  manifest.contracts.thresholdAuthority,
  "getOwners",
);
const authorityThreshold = await read(
  "AgentPoolV44ThresholdAuthority",
  manifest.contracts.thresholdAuthority,
  "getThreshold",
);
check(
  "thresholdAuthority.owners",
  JSON.stringify(authorityOwners.map((owner) => owner.toLowerCase())),
  JSON.stringify(
    manifest.thresholdAuthorityOwners.map((owner) => owner.toLowerCase()),
  ),
);
check(
  "thresholdAuthority.threshold",
  Number(authorityThreshold),
  manifest.thresholdAuthorityThreshold,
);
const maturityAuthority = await read(
  "AgentPoolV44MaturityAnchor",
  manifest.contracts.maturityAnchor,
  "AUTHORITY",
);
check(
  "maturityAnchor.authority",
  maturityAuthority,
  manifest.contracts.thresholdAuthority,
);
check(
  "bootstrapVerifierCodehashMatchesObjectiveVerifier",
  manifest.bootstrapVerifierCodehash,
  codeHashes.objectiveVerifier,
);

const configurationHashes = Object.values(
  manifest.configurationTransactions ?? {},
);
function configurationKey(address, functionName) {
  return `${address.toLowerCase()}:${functionName}`;
}
function configurationInput(name, functionName, args) {
  return encodeFunctionData({
    abi: artifact(name).abi,
    functionName,
    args,
  });
}
const expectedConfigurationInputs = Object.fromEntries([
  [
    configurationKey(manifest.contracts.token, "configureMinters"),
    configurationInput("AgentPoolV44Token", "configureMinters", [
      manifest.contracts.coreEpochVault,
      manifest.contracts.evolutionEpochVault,
    ]),
  ],
  ...[
    manifest.contracts.coreEpochVault,
    manifest.contracts.evolutionEpochVault,
  ].map((address) => [
    configurationKey(address, "configureMarket"),
    configurationInput("AgentPoolV43EpochVault", "configureMarket", [
      manifest.contracts.taskMarket,
    ]),
  ]),
  ...[
    ["AgentPoolV43UserEscrowKernel", manifest.contracts.userEscrow],
    ["AgentPoolV43CapacityRegistry", manifest.contracts.capacityRegistry],
    ["AgentPoolV432ProofRegistry", manifest.contracts.proofRegistry],
  ].map(([name, address]) => [
    configurationKey(address, "configureMarket"),
    configurationInput(name, "configureMarket", [
      manifest.contracts.taskMarket,
    ]),
  ]),
  [
    configurationKey(
      manifest.contracts.contributionLedger,
      "configureConsensus",
    ),
    configurationInput(
      "AgentPoolV43ContributionLedger",
      "configureConsensus",
      [manifest.contracts.evolutionConsensus],
    ),
  ],
  [
    configurationKey(
      manifest.contracts.releaseRegistry,
      "configureConsensus",
    ),
    configurationInput(
      "AgentPoolV43ReleaseRegistry",
      "configureConsensus",
      [manifest.contracts.evolutionConsensus],
    ),
  ],
  [
    configurationKey(manifest.contracts.settlementRouter, "configure"),
    configurationInput("AgentPoolV43SettlementRouter", "configure", [
      manifest.contracts.contributionLedger,
      manifest.contracts.evolutionConsensus,
      manifest.contracts.taskMarket,
    ]),
  ],
  [
    configurationKey(manifest.contracts.systemIssueGate, "configure"),
    configurationInput("AgentPoolV435SystemIssueGate", "configure", [
      manifest.contracts.taskMarket,
      manifest.contracts.transitionIssueConsensus,
      manifest.contracts.issueConsensus,
    ]),
  ],
]);
checkExactKeys(
  "manifest.configurationTransactionKeysExact",
  manifest.configurationTransactions,
  Object.keys(expectedConfigurationInputs),
);
checkExactKeys(
  "manifest.configurationInputHashKeysExact",
  manifest.configurationInputHashes,
  Object.keys(expectedConfigurationInputs),
);
checkExactKeys(
  "manifest.transactionIntentKeysExact",
  manifest.transactionIntents,
  [
    ...canonicalContractKeys.map((key) => `deploy:${key}`),
    ...Object.keys(expectedConfigurationInputs).map(
      (key) => `configure:${key}`,
    ),
  ],
);
check(
  "manifest.configurationCount",
  Object.keys(manifest.configurationTransactions ?? {}).length,
  Object.keys(expectedConfigurationInputs).length,
);
for (const [key, hash] of Object.entries(
  manifest.configurationTransactions ?? {},
)) {
  const [address] = key.split(":");
  const receipt = await client.getTransactionReceipt({ hash });
  const transaction = await client.getTransaction({ hash });
  const intent = manifest.transactionIntents?.[`configure:${key}`];
  if (!intent) throw new Error(`V44_CONFIGURATION_INTENT_MISSING:${key}`);
  const expectedInput = expectedConfigurationInputs[key];
  if (!expectedInput) {
    throw new Error(`V44_CONFIGURATION_STEP_UNEXPECTED:${key}`);
  }
  assertConfigurationProvenance({
    key,
    expectedFrom: manifest.deployer,
    expectedTo: address,
    expectedInput,
    transaction,
    receipt,
  });
  check(`configurationTransaction.intentHash:${key}`, intent.hash, hash);
  check(
    `configurationTransaction.intentNonce:${key}`,
    intent.nonce,
    transaction.nonce,
  );
  check(
    `configurationTransaction.intentInputHash:${key}`,
    intent.inputHash,
    keccak256(transaction.input),
  );
  check(
    `configurationTransaction.inputHash:${key}`,
    keccak256(transaction.input),
    manifest.configurationInputHashes?.[key],
  );
}
const expectedTransactionHashes = [
  ...new Set([
    ...Object.values(manifest.deploymentTransactions ?? {}),
    ...configurationHashes,
  ]),
].sort();
const recordedTransactionHashes = [
  ...new Set(manifest.transactionHashes ?? []),
].sort();
check(
  "manifest.transactionHashesUnique",
  (manifest.transactionHashes ?? []).length,
  recordedTransactionHashes.length,
);
check(
  "manifest.transactionSetComplete",
  JSON.stringify(recordedTransactionHashes),
  JSON.stringify(expectedTransactionHashes),
);

check(
  "bootstrap.issueRoot",
  manifest.bootstrap?.issueRoot,
  expectedBootstrap.issueRoot,
);
check(
  "bootstrap.objectiveRoot",
  manifest.bootstrap?.objectiveRoot,
  expectedBootstrap.objectiveRoot,
);
check(
  "bootstrap.objectivesSha256",
  manifest.bootstrap?.objectivesSha256,
  releaseInputs.bootstrap.objectivesSha256,
);
check(
  "bootstrap.objectiveCount",
  manifest.bootstrap?.objectives?.length,
  releaseInputs.bootstrap.objectives.length,
);
check(
  "bootstrap.objectivesExact",
  JSON.stringify(manifest.bootstrap?.objectives),
  JSON.stringify(
    redactBootstrapSecrets({
      objectives: expectedBootstrap.objectives,
    }).objectives,
  ),
);

for (const [label, name, address, field] of [
  [
    "token",
    "AgentPoolV44Token",
    manifest.contracts.token,
    "configurationAuthority",
  ],
  [
    "escrow",
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
    "configurationAuthority",
  ],
  [
    "coreVault",
    "AgentPoolV43EpochVault",
    manifest.contracts.coreEpochVault,
    "configurationAuthority",
  ],
  [
    "evolutionVault",
    "AgentPoolV43EpochVault",
    manifest.contracts.evolutionEpochVault,
    "configurationAuthority",
  ],
  [
    "ledger",
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "bootstrapAuthority",
  ],
  [
    "registry",
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "configurationAuthority",
  ],
  [
    "capacity",
    "AgentPoolV43CapacityRegistry",
    manifest.contracts.capacityRegistry,
    "configurationAuthority",
  ],
  [
    "proof",
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
    "configurationAuthority",
  ],
  [
    "router",
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "configurationAuthority",
  ],
  [
    "issueGate",
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "configurationAuthority",
  ],
]) {
  check(
    `${label}.temporaryAuthorityRemoved`,
    await read(name, address, field),
    ZERO_ADDRESS,
  );
}

check(
  "token.name",
  await read("AgentPoolV44Token", manifest.contracts.token, "name"),
  "AgentPool",
);
check(
  "token.symbol",
  await read("AgentPoolV44Token", manifest.contracts.token, "symbol"),
  "APOOL",
);
check(
  "token.decimals",
  await read("AgentPoolV44Token", manifest.contracts.token, "decimals"),
  18,
);
check(
  "token.maxSupply",
  await read("AgentPoolV44Token", manifest.contracts.token, "MAX_SUPPLY"),
  parseEther(configEvidence.config.token.maxSupplyApool),
);
check(
  "token.coreMinter",
  await read(
    "AgentPoolV44Token",
    manifest.contracts.token,
    "coreEpochVault",
  ),
  manifest.contracts.coreEpochVault,
);
check(
  "token.evolutionMinter",
  await read(
    "AgentPoolV44Token",
    manifest.contracts.token,
    "evolutionEpochVault",
  ),
  manifest.contracts.evolutionEpochVault,
);

for (const [label, address, lane, weeklyCap, lifetimeCap] of [
  [
    "coreVault",
    manifest.contracts.coreEpochVault,
    keccak256("0x434f5245"),
    configEvidence.config.emission.coreWeeklyCapApool,
    configEvidence.config.emission.coreLifetimeCapApool,
  ],
  [
    "evolutionVault",
    manifest.contracts.evolutionEpochVault,
    keccak256("0x45564f4c5554494f4e"),
    configEvidence.config.emission.evolutionWeeklyCapApool,
    configEvidence.config.emission.evolutionLifetimeCapApool,
  ],
]) {
  check(
    `${label}.token`,
    await read("AgentPoolV43EpochVault", address, "token"),
    manifest.contracts.token,
  );
  check(
    `${label}.lane`,
    await read("AgentPoolV43EpochVault", address, "lane"),
    lane,
  );
  check(
    `${label}.market`,
    await read("AgentPoolV43EpochVault", address, "market"),
    manifest.contracts.taskMarket,
  );
  check(
    `${label}.genesisStart`,
    await read("AgentPoolV43EpochVault", address, "genesisStart"),
    BigInt(manifest.genesisStart),
  );
  check(
    `${label}.weeklyCap`,
    await read("AgentPoolV43EpochVault", address, "weeklyCap"),
    parseEther(weeklyCap),
  );
  check(
    `${label}.lifetimeCap`,
    await read("AgentPoolV43EpochVault", address, "lifetimeCap"),
    parseEther(lifetimeCap),
  );
}

const coreEmitted = await read(
  "AgentPoolV43EpochVault",
  manifest.contracts.coreEpochVault,
  "totalEmitted",
);
const evolutionEmitted = await read(
  "AgentPoolV43EpochVault",
  manifest.contracts.evolutionEpochVault,
  "totalEmitted",
);
const totalSupply = await read(
  "AgentPoolV44Token",
  manifest.contracts.token,
  "totalSupply",
);
check(
  "token.supplyEqualsEpochEmissions",
  totalSupply,
  coreEmitted + evolutionEmitted,
);
check(
  "token.supplyAtOrBelowMax",
  totalSupply <= parseEther(configEvidence.config.token.maxSupplyApool),
  true,
);

for (const [label, name, address] of [
  [
    "escrow",
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
  ],
  [
    "capacity",
    "AgentPoolV43CapacityRegistry",
    manifest.contracts.capacityRegistry,
  ],
  [
    "proof",
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
  ],
]) {
  check(
    `${label}.market`,
    await read(name, address, "market"),
    manifest.contracts.taskMarket,
  );
}
check(
  "escrow.token",
  await read(
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
    "token",
  ),
  manifest.contracts.token,
);
check(
  "ledger.genesisStart",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "genesisStart",
  ),
  BigInt(manifest.genesisStart),
);
check(
  "proof.ledger",
  await read(
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
    "ledger",
  ),
  manifest.contracts.contributionLedger,
);
for (const [field, expected] of [
  ["token", manifest.contracts.token],
  ["userEscrow", manifest.contracts.userEscrow],
  ["coreEpochVault", manifest.contracts.coreEpochVault],
  ["evolutionEpochVault", manifest.contracts.evolutionEpochVault],
  ["contributionLedger", manifest.contracts.contributionLedger],
  ["releaseRegistry", manifest.contracts.releaseRegistry],
  ["capacityRegistry", manifest.contracts.capacityRegistry],
  ["proofRegistry", manifest.contracts.proofRegistry],
  ["settlementRouter", manifest.contracts.settlementRouter],
  ["systemIssueGate", manifest.contracts.systemIssueGate],
]) {
  check(
    `taskMarket.${field}`,
    await read(
      "AgentPoolV432TaskMarket",
      manifest.contracts.taskMarket,
      field,
    ),
    expected,
  );
}
check(
  "registry.consensus",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "registry.recommendedRelease",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "recommendedRelease",
  ),
  manifest.genesisRelease,
);
check(
  "ledger.consensus",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "ledger.activeSettlementRouter",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "isActiveSource",
    [manifest.contracts.settlementRouter],
  ),
  true,
);
for (const [field, expected] of [
  ["token", manifest.contracts.token],
  ["ledger", manifest.contracts.contributionLedger],
  ["releaseRegistry", manifest.contracts.releaseRegistry],
  ["financeInvariantHash", manifest.financeInvariantHash],
  ["recommendedRelease", manifest.genesisRelease],
]) {
  check(
    `evolutionConsensus.${field}`,
    await read(
      "AgentPoolV43EvolutionConsensus",
      manifest.contracts.evolutionConsensus,
      field,
    ),
    expected,
  );
}
check(
  "evolutionConsensus.minimumProposalBond",
  await read(
    "AgentPoolV43EvolutionConsensus",
    manifest.contracts.evolutionConsensus,
    "minimumProposalBond",
  ),
  parseEther(configEvidence.config.consensus.proposalBondApool),
);
check(
  "router.market",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "market",
  ),
  manifest.contracts.taskMarket,
);
check(
  "router.ledger",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "ledger",
  ),
  manifest.contracts.contributionLedger,
);
check(
  "router.consensus",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "taskMarket.financeInvariant",
  await read(
    "AgentPoolV432TaskMarket",
    manifest.contracts.taskMarket,
    "financeInvariantHash",
  ),
  manifest.financeInvariantHash,
);
check(
  "issueGate.market",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "market",
  ),
  manifest.contracts.taskMarket,
);
check(
  "issueGate.transitionConsensus",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "transitionConsensus",
  ),
  manifest.contracts.transitionIssueConsensus,
);
check(
  "issueGate.matureConsensus",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "matureConsensus",
  ),
  manifest.contracts.issueConsensus,
);
check(
  "issueGate.bootstrapRoot",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "bootstrapRoot",
  ),
  manifest.bootstrap.issueRoot,
);
check(
  "issueGate.dynamicVerifierCodehash",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "dynamicVerifierCodehash",
  ),
  manifest.bootstrapVerifierCodehash,
);
check(
  "issueGate.dynamicValidatorRoot",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "dynamicValidatorRoot",
  ),
  manifest.bootstrap.validatorRoot,
);
for (const [field, expected] of [
  ["token", manifest.contracts.token],
  ["ledger", manifest.contracts.contributionLedger],
  [
    "dynamicCandidateBudgetCap",
    parseEther(configEvidence.config.dynamicIssues.candidateBudgetCapApool),
  ],
  [
    "dynamicIssueBudgetCap",
    parseEther(configEvidence.config.dynamicIssues.issueBudgetCapApool),
  ],
  ["dynamicMaxCandidates", configEvidence.config.dynamicIssues.maxCandidates],
  [
    "dynamicMaxLifetime",
    BigInt(configEvidence.config.dynamicIssues.maxLifetimeSeconds),
  ],
  [
    "dynamicCandidateBond",
    parseEther(
      configEvidence.config.dynamicIssues.candidateAdmissionBondApool,
    ),
  ],
]) {
  check(
    `issueGate.${field}`,
    await read(
      "AgentPoolV435SystemIssueGate",
      manifest.contracts.systemIssueGate,
      field,
    ),
    expected,
  );
}
for (const [label, contractName, address] of [
  [
    "transitionConsensus",
    "AgentPoolV435TransitionIssueConsensus",
    manifest.contracts.transitionIssueConsensus,
  ],
  [
    "matureConsensus",
    "AgentPoolV432IssueConsensus",
    manifest.contracts.issueConsensus,
  ],
]) {
  for (const [field, expected] of [
    ["token", manifest.contracts.token],
    ["ledger", manifest.contracts.contributionLedger],
    ["issueGate", manifest.contracts.systemIssueGate],
  ]) {
    check(
      `${label}.${field}`,
      await read(contractName, address, field),
      expected,
    );
  }
  check(
    `${label}.minimumBond`,
    await read(contractName, address, "minimumBond"),
    parseEther(configEvidence.config.consensus.proposalBondApool),
  );
}

for (const [index, hash] of manifest.transactionHashes.entries()) {
  const receipt = await client.getTransactionReceipt({ hash });
  check(`deployment.transaction:${index + 1}`, receipt.status, "success");
  check(
    `deployment.transactionChain:${index + 1}`,
    receipt.chainId ?? profile.chainId,
    profile.chainId,
  );
}

const report = {
  schema: profile.verificationSchema,
  ok: checks.every((entry) => entry.passed),
  release: VERSION,
  deploymentProfile: profile.id,
  testnetOnly: profile.testnetOnly,
  network: profile.network,
  chainId: profile.chainId,
  phase: "BOOTSTRAP",
  manifestPath,
  totalSupply: totalSupply.toString(),
  codeHashes,
  checks,
  verifiedAt: new Date().toISOString(),
};
const reportPath = profile.verificationPath;
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) throw new Error(`V44_VERIFICATION_FAILED:${reportPath}`);
process.stdout.write(
  `${JSON.stringify(
    { ok: true, checks: checks.length, reportPath },
    null,
    2,
  )}\n`,
);
