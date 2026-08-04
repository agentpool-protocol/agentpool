import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  artifactBytecodeEvidence,
  bootstrapIdentitySha256,
  assertConfigurationProvenance,
  assertDeploymentProvenance,
  assertTrackedTreeClean,
  attachTransactionHash,
  beginTransactionIntent,
  buildBootstrapTerms,
  collectReleaseInputs,
  loadAndValidateConfig,
  loadAndValidateGates,
  redactBootstrapSecrets,
  requireEnv,
  requireThresholdAuthorityConfig,
  serializeIssue,
  sha256Json,
} from "./lib/v44-mainnet.mjs";
import {
  requireProfileEnvironment,
  resolveV44ChainProfile,
} from "./lib/v44-chain-profile.mjs";
import { verifyV44ReleaseEvidenceFile } from "./generate-v44-release-evidence.mjs";
import {
  verifyPublicTestnetReliabilityGate,
} from "./lib/v44-testnet-reliability.mjs";
import { loadBootstrapSpecificationEvidence } from "./lib/v44-bootstrap-specifications.mjs";

const profile = resolveV44ChainProfile({
  ...process.env,
  V44_DEPLOYMENT_PROFILE: process.argv.includes("--testnet")
    ? "testnet"
    : "mainnet",
});
const { manifestPath, partialPath } = profile;
if (fs.existsSync(manifestPath)) throw new Error("V44_ALREADY_DEPLOYED");
if (
  profile.testnetOnly &&
  profile.historicalSourceEvidencePath &&
  fs.existsSync(profile.historicalSourceEvidencePath)
) {
  throw new Error("V44_HISTORICAL_SOURCE_EVIDENCE_ALREADY_EXISTS");
}
if (
  profile.testnetOnly &&
  profile.historicalBootstrapSpecificationsPath &&
  fs.existsSync(profile.historicalBootstrapSpecificationsPath)
) {
  throw new Error("V44_HISTORICAL_BOOTSTRAP_SPECIFICATIONS_ALREADY_EXISTS");
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
const config = configEvidence.config;
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const thresholdAuthority = requireThresholdAuthorityConfig();
const releaseInputs = collectReleaseInputs({
  deployerAddress: account.address,
});
const bootstrapCatalogId = profile.testnetOnly
  ? profile.campaignId ?? "legacy-testnet"
  : requireEnv("V44_BOOTSTRAP_CATALOG_ID");
const bootstrapSpecificationEvidence =
  loadBootstrapSpecificationEvidence({
    sourceEvidence: sourceEvidence.evidence,
    objectivesPath: releaseInputs.bootstrap.objectivesPath,
    objectives: releaseInputs.bootstrap.objectives,
    catalogId: bootstrapCatalogId,
    allowMechanicsOnly: profile.testnetOnly,
  });
const { rpcUrl, minimumBalance } = requireProfileEnvironment(profile);
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: profile.chain, transport });
const wallet = createWalletClient({
  account,
  chain: profile.chain,
  transport,
});
const actualChainId = await client.getChainId();
if (actualChainId !== profile.chainId) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}
const balance = await client.getBalance({ address: account.address });
if (balance < minimumBalance) {
  throw new Error(
    `V44_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
  );
}
const existingPartial = fs.existsSync(partialPath)
  ? JSON.parse(fs.readFileSync(partialPath, "utf8"))
  : null;
const deploymentIdentity = {
  version: VERSION,
  deploymentProfile: profile.id,
  chainId: profile.chainId,
  sourceCommit: releaseInputs.sourceCommit,
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence?.gatesSha256 ?? null,
  deployer: account.address,
  thresholdAuthorityOwnersHash: sha256Json(thresholdAuthority.owners),
  thresholdAuthorityThreshold: thresholdAuthority.threshold,
  genesisStart: releaseInputs.genesisStart,
  genesisRelease: releaseInputs.genesisRelease,
  bootstrapObjectivesSha256: releaseInputs.bootstrap.objectivesSha256,
  bootstrapCatalogId,
  bootstrapObjectiveMode: bootstrapSpecificationEvidence.mode,
  bootstrapSpecificationsSha256:
    bootstrapSpecificationEvidence.specificationsSha256 ?? null,
  bootstrapIdentitySha256: bootstrapIdentitySha256(releaseInputs),
};
if (existingPartial) {
  if (existingPartial.schemaVersion !== 3) {
    throw new Error("V44_PARTIAL_SCHEMA_UNSUPPORTED");
  }
  for (const [key, expected] of Object.entries(deploymentIdentity)) {
    const actual =
      key === "deploymentProfile" && existingPartial[key] === undefined
        ? "mainnet"
        : existingPartial[key];
    const same =
      typeof expected === "string" && typeof actual === "string"
        ? expected.toLowerCase() === actual.toLowerCase()
        : expected === actual;
    if (!same) throw new Error(`V44_PARTIAL_IDENTITY_MISMATCH:${key}`);
  }
}

const state = existingPartial ?? {
  schemaVersion: 3,
  ...deploymentIdentity,
  network: profile.network,
  contracts: {},
  transactionHashes: [],
  deploymentTransactions: {},
  creationInputHashes: {},
  configurationTransactions: {},
  configurationInputHashes: {},
  transactionIntents: {},
  accountedTransactionHashes: [],
  gasUsed: "0",
};
state.transactionHashes = [...new Set(state.transactionHashes ?? [])];
state.deploymentTransactions ??= {};
state.creationInputHashes ??= {};
state.configurationTransactions ??= {};
state.configurationInputHashes ??= {};
state.transactionIntents ??= {};
state.accountedTransactionHashes ??= [];
let gasUsed = BigInt(state.gasUsed ?? "0");

function savePartial() {
  state.gasUsed = gasUsed.toString();
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readCodeWithRetry(address, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const code = await client.getCode({ address });
    if (code && code !== "0x") return code;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  return "0x";
}

async function assertCode(address, label) {
  const code = await readCodeWithRetry(address);
  if (code === "0x") throw new Error(`V44_MISSING_CODE:${label}`);
  return code;
}

function recordTransaction(hash) {
  if (!state.transactionHashes.includes(hash)) {
    state.transactionHashes.push(hash);
  }
}

function accountReceiptGas(hash, receipt) {
  if (!state.accountedTransactionHashes.includes(hash)) {
    gasUsed += receipt.gasUsed;
    state.accountedTransactionHashes.push(hash);
  }
}

async function waitForSuccess(hash, label) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`${label}_FAILED:${hash}`);
  }
  accountReceiptGas(hash, receipt);
  return receipt;
}

async function validateDeployment(name, args, key) {
  const hash = state.deploymentTransactions[key];
  if (!hash) throw new Error(`V44_PARTIAL_DEPLOYMENT_TX_MISSING:${key}`);
  const compiled = artifact(name);
  const expectedInput = encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  const receipt = await waitForSuccess(hash, `${name}_DEPLOYMENT`);
  const transaction = await client.getTransaction({ hash });
  const address = assertDeploymentProvenance({
    key,
    expectedFrom: account.address,
    expectedInput,
    expectedAddress: state.contracts[key],
    transaction,
    receipt,
  });
  await assertCode(address, key);
  state.contracts[key] = address;
  state.creationInputHashes[key] = keccak256(expectedInput);
  recordTransaction(hash);
  savePartial();
  return address;
}

async function deploy(name, args, key) {
  if (state.contracts[key] && !state.deploymentTransactions[key]) {
    throw new Error(`V44_PARTIAL_DEPLOYMENT_TX_MISSING:${key}`);
  }
  if (state.deploymentTransactions[key]) {
    return validateDeployment(name, args, key);
  }
  const compiled = artifact(name);
  const expectedInput = encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  const intentKey = `deploy:${key}`;
  const nonce = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  beginTransactionIntent({
    intents: state.transactionIntents,
    key: intentKey,
    kind: "deployment",
    nonce,
    to: null,
    inputHash: keccak256(expectedInput),
  });
  savePartial();
  const hash = await wallet.deployContract({
    account,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
    nonce,
  });
  state.deploymentTransactions[key] = hash;
  attachTransactionHash({
    intents: state.transactionIntents,
    key: intentKey,
    hash,
  });
  state.creationInputHashes[key] = keccak256(expectedInput);
  recordTransaction(hash);
  savePartial();
  return validateDeployment(name, args, key);
}

async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}

async function write(name, address, functionName, args, configured) {
  const normalizedAddress = getAddress(address);
  const step = `${normalizedAddress.toLowerCase()}:${functionName}`;
  const expectedInput = encodeFunctionData({
    abi: artifact(name).abi,
    functionName,
    args,
  });
  const existingHash = state.configurationTransactions[step];
  if (configured && !existingHash) {
    throw new Error(`V44_PARTIAL_CONFIGURATION_TX_MISSING:${step}`);
  }
  if (existingHash) {
    const receipt = await waitForSuccess(
      existingHash,
      `${name}.${functionName}`,
    );
    const transaction = await client.getTransaction({ hash: existingHash });
    assertConfigurationProvenance({
      key: step,
      expectedFrom: account.address,
      expectedTo: normalizedAddress,
      expectedInput,
      transaction,
      receipt,
    });
    state.configurationInputHashes[step] = keccak256(expectedInput);
    recordTransaction(existingHash);
    savePartial();
    return existingHash;
  }
  const intentKey = `configure:${step}`;
  const simulation = await client.simulateContract({
    account,
    address: normalizedAddress,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  const nonce = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  beginTransactionIntent({
    intents: state.transactionIntents,
    key: intentKey,
    kind: "configuration",
    nonce,
    to: normalizedAddress,
    inputHash: keccak256(expectedInput),
  });
  savePartial();
  const hash = await wallet.writeContract({
    ...simulation.request,
    nonce,
  });
  state.configurationTransactions[step] = hash;
  attachTransactionHash({
    intents: state.transactionIntents,
    key: intentKey,
    hash,
  });
  state.configurationInputHashes[step] = keccak256(expectedInput);
  recordTransaction(hash);
  savePartial();
  return write(name, normalizedAddress, functionName, args, false);
}

const financeInvariantHash = configEvidence.financeInvariantHash;
const proposalBond = parseEther(config.consensus.proposalBondApool);
const coreWeeklyCap = parseEther(config.emission.coreWeeklyCapApool);
const evolutionWeeklyCap = parseEther(
  config.emission.evolutionWeeklyCapApool,
);
const coreLifetimeCap = parseEther(config.emission.coreLifetimeCapApool);
const evolutionLifetimeCap = parseEther(
  config.emission.evolutionLifetimeCapApool,
);
const dynamicCandidateBudgetCap = parseEther(
  config.dynamicIssues.candidateBudgetCapApool,
);
const dynamicIssueBudgetCap = parseEther(
  config.dynamicIssues.issueBudgetCapApool,
);
const dynamicCandidateBond = parseEther(
  config.dynamicIssues.candidateAdmissionBondApool,
);

const token = await deploy("AgentPoolV44Token", [account.address], "token");
const settlementRouter = await deploy(
  "AgentPoolV43SettlementRouter",
  [account.address],
  "settlementRouter",
);
const releaseRegistry = await deploy(
  "AgentPoolV43ReleaseRegistry",
  [
    releaseInputs.genesisRelease,
    releaseInputs.genesisModuleHash,
    releaseInputs.genesisManifestHash,
    account.address,
  ],
  "releaseRegistry",
);
const capacityRegistry = await deploy(
  "AgentPoolV43CapacityRegistry",
  [account.address],
  "capacityRegistry",
);
const userEscrow = await deploy(
  "AgentPoolV43UserEscrowKernel",
  [token, account.address],
  "userEscrow",
);
const coreEpochVault = await deploy(
  "AgentPoolV43EpochVault",
  [
    token,
    keccak256(toBytes("CORE")),
    releaseInputs.genesisStart,
    coreWeeklyCap,
    coreLifetimeCap,
    account.address,
  ],
  "coreEpochVault",
);
const evolutionEpochVault = await deploy(
  "AgentPoolV43EpochVault",
  [
    token,
    keccak256(toBytes("EVOLUTION")),
    releaseInputs.genesisStart,
    evolutionWeeklyCap,
    evolutionLifetimeCap,
    account.address,
  ],
  "evolutionEpochVault",
);
const contributionLedger = await deploy(
  "AgentPoolV43ContributionLedger",
  [releaseInputs.genesisStart, settlementRouter, account.address],
  "contributionLedger",
);
const proofRegistry = await deploy(
  "AgentPoolV432ProofRegistry",
  [contributionLedger, account.address],
  "proofRegistry",
);
const evolutionConsensus = await deploy(
  "AgentPoolV43EvolutionConsensus",
  [
    token,
    contributionLedger,
    releaseRegistry,
    financeInvariantHash,
    releaseInputs.genesisRelease,
    proposalBond,
  ],
  "evolutionConsensus",
);
const objectiveVerifier = await deploy(
  "AgentPoolV43HashObjectiveVerifier",
  [],
  "objectiveVerifier",
);
const policyActivationAuthority = await deploy(
  "AgentPoolV44ThresholdAuthority",
  [thresholdAuthority.owners, thresholdAuthority.threshold],
  "thresholdAuthority",
);
await deploy(
  "AgentPoolV44PolicyAnchor",
  [policyActivationAuthority],
  "policyAnchor",
);
await deploy(
  "AgentPoolV44MaturityAnchor",
  [policyActivationAuthority],
  "maturityAnchor",
);
const verifierCode = await assertCode(objectiveVerifier, "objectiveVerifier");
const verifierCodehash = keccak256(verifierCode);
const bootstrap = buildBootstrapTerms({
  config,
  releaseInputs,
  verifier: objectiveVerifier,
});
state.bootstrap = {
  issue: serializeIssue(bootstrap.issue),
  issueRoot: bootstrap.issueRoot,
  objectiveRoot: bootstrap.objectiveRoot,
  expectedEvidenceHash: bootstrap.expectedEvidenceHash,
  validatorRoot: bootstrap.validatorRoot,
  validators: bootstrap.validators,
  objectives: bootstrap.objectives,
  objectivesSha256: bootstrap.objectivesSha256,
};
savePartial();

const systemIssueGate = await deploy(
  "AgentPoolV435SystemIssueGate",
  [
    bootstrap.issueRoot,
    token,
    contributionLedger,
    account.address,
    verifierCodehash,
    bootstrap.validatorRoot,
    dynamicCandidateBudgetCap,
    dynamicIssueBudgetCap,
    config.dynamicIssues.maxCandidates,
    config.dynamicIssues.maxLifetimeSeconds,
    dynamicCandidateBond,
  ],
  "systemIssueGate",
);
const transitionIssueConsensus = await deploy(
  "AgentPoolV435TransitionIssueConsensus",
  [token, contributionLedger, systemIssueGate, proposalBond],
  "transitionIssueConsensus",
);
const issueConsensus = await deploy(
  "AgentPoolV432IssueConsensus",
  [token, contributionLedger, systemIssueGate, proposalBond],
  "issueConsensus",
);
const taskMarket = await deploy(
  "AgentPoolV432TaskMarket",
  [
    token,
    userEscrow,
    coreEpochVault,
    evolutionEpochVault,
    contributionLedger,
    releaseRegistry,
    capacityRegistry,
    proofRegistry,
    settlementRouter,
    systemIssueGate,
    financeInvariantHash,
    config.dynamicIssues.maxGovernanceMilestones,
  ],
  "taskMarket",
);

await write(
  "AgentPoolV44Token",
  token,
  "configureMinters",
  [coreEpochVault, evolutionEpochVault],
  (await read(
    "AgentPoolV44Token",
    token,
    "configurationAuthority",
  )) === ZERO_ADDRESS,
);
for (const address of [coreEpochVault, evolutionEpochVault]) {
  await write(
    "AgentPoolV43EpochVault",
    address,
    "configureMarket",
    [taskMarket],
    (await read("AgentPoolV43EpochVault", address, "market")) !== ZERO_ADDRESS,
  );
}
for (const [name, address] of [
  ["AgentPoolV43UserEscrowKernel", userEscrow],
  ["AgentPoolV43CapacityRegistry", capacityRegistry],
  ["AgentPoolV432ProofRegistry", proofRegistry],
]) {
  await write(
    name,
    address,
    "configureMarket",
    [taskMarket],
    (await read(name, address, "market")) !== ZERO_ADDRESS,
  );
}
await write(
  "AgentPoolV43ContributionLedger",
  contributionLedger,
  "configureConsensus",
  [evolutionConsensus],
  (await read(
    "AgentPoolV43ContributionLedger",
    contributionLedger,
    "consensus",
  )) !== ZERO_ADDRESS,
);
await write(
  "AgentPoolV43ReleaseRegistry",
  releaseRegistry,
  "configureConsensus",
  [evolutionConsensus],
  (await read(
    "AgentPoolV43ReleaseRegistry",
    releaseRegistry,
    "consensus",
  )) !== ZERO_ADDRESS,
);
await write(
  "AgentPoolV43SettlementRouter",
  settlementRouter,
  "configure",
  [contributionLedger, evolutionConsensus, taskMarket],
  (await read(
    "AgentPoolV43SettlementRouter",
    settlementRouter,
    "market",
  )) !== ZERO_ADDRESS,
);
await write(
  "AgentPoolV435SystemIssueGate",
  systemIssueGate,
  "configure",
  [taskMarket, transitionIssueConsensus, issueConsensus],
  (await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "market",
  )) !== ZERO_ADDRESS,
);

const authorityChecks = [
  ["AgentPoolV44Token", token, "configurationAuthority"],
  ["AgentPoolV43SettlementRouter", settlementRouter, "configurationAuthority"],
  ["AgentPoolV43ReleaseRegistry", releaseRegistry, "configurationAuthority"],
  ["AgentPoolV43CapacityRegistry", capacityRegistry, "configurationAuthority"],
  ["AgentPoolV43UserEscrowKernel", userEscrow, "configurationAuthority"],
  ["AgentPoolV43EpochVault", coreEpochVault, "configurationAuthority"],
  ["AgentPoolV43EpochVault", evolutionEpochVault, "configurationAuthority"],
  [
    "AgentPoolV43ContributionLedger",
    contributionLedger,
    "bootstrapAuthority",
  ],
  ["AgentPoolV432ProofRegistry", proofRegistry, "configurationAuthority"],
  ["AgentPoolV435SystemIssueGate", systemIssueGate, "configurationAuthority"],
];
for (const [name, address, functionName] of authorityChecks) {
  const authority = await read(name, address, functionName);
  if (authority.toLowerCase() !== ZERO_ADDRESS) {
    throw new Error(`V44_RESIDUAL_AUTHORITY:${name}:${authority}`);
  }
}
for (const [label, name, address, functionName, expected] of [
  [
    "token.coreMinter",
    "AgentPoolV44Token",
    token,
    "coreEpochVault",
    coreEpochVault,
  ],
  [
    "token.evolutionMinter",
    "AgentPoolV44Token",
    token,
    "evolutionEpochVault",
    evolutionEpochVault,
  ],
  [
    "coreVault.market",
    "AgentPoolV43EpochVault",
    coreEpochVault,
    "market",
    taskMarket,
  ],
  [
    "evolutionVault.market",
    "AgentPoolV43EpochVault",
    evolutionEpochVault,
    "market",
    taskMarket,
  ],
  [
    "escrow.market",
    "AgentPoolV43UserEscrowKernel",
    userEscrow,
    "market",
    taskMarket,
  ],
  [
    "capacity.market",
    "AgentPoolV43CapacityRegistry",
    capacityRegistry,
    "market",
    taskMarket,
  ],
  [
    "proof.market",
    "AgentPoolV432ProofRegistry",
    proofRegistry,
    "market",
    taskMarket,
  ],
  [
    "ledger.consensus",
    "AgentPoolV43ContributionLedger",
    contributionLedger,
    "consensus",
    evolutionConsensus,
  ],
  [
    "registry.consensus",
    "AgentPoolV43ReleaseRegistry",
    releaseRegistry,
    "consensus",
    evolutionConsensus,
  ],
  [
    "router.ledger",
    "AgentPoolV43SettlementRouter",
    settlementRouter,
    "ledger",
    contributionLedger,
  ],
  [
    "router.consensus",
    "AgentPoolV43SettlementRouter",
    settlementRouter,
    "consensus",
    evolutionConsensus,
  ],
  [
    "router.market",
    "AgentPoolV43SettlementRouter",
    settlementRouter,
    "market",
    taskMarket,
  ],
  [
    "issueGate.market",
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "market",
    taskMarket,
  ],
  [
    "issueGate.transitionConsensus",
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "transitionConsensus",
    transitionIssueConsensus,
  ],
  [
    "issueGate.matureConsensus",
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "matureConsensus",
    issueConsensus,
  ],
]) {
  const actual = await read(name, address, functionName);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`V44_WIRING_MISMATCH:${label}:${actual}:${expected}`);
  }
}
if ((await read("AgentPoolV44Token", token, "totalSupply")) !== 0n) {
  throw new Error("V44_PREMINT_DETECTED");
}

const deployedCodeHashes = {};
for (const [key, address] of Object.entries(state.contracts)) {
  deployedCodeHashes[key] = keccak256(await assertCode(address, key));
}
const artifacts = artifactBytecodeEvidence();
const deploymentReceipts = await Promise.all(
  Object.values(state.deploymentTransactions).map((hash) =>
    client.getTransactionReceipt({ hash }),
  ),
);
const deploymentBlock = Number(
  deploymentReceipts.reduce(
    (minimum, receipt) =>
      receipt.blockNumber < minimum ? receipt.blockNumber : minimum,
    deploymentReceipts[0].blockNumber,
  ),
);
const commonManifest = {
  schema: profile.manifestSchema,
  version: VERSION,
  chainId: profile.chainId,
  network: profile.network,
  campaignId: profile.campaignId ?? null,
  phase: "BOOTSTRAP",
  sourceCommit: releaseInputs.sourceCommit,
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence?.gatesSha256 ?? null,
  approvedGateEvidence: gateEvidence?.approved ?? null,
  sourceEvidenceFileSha256: sourceEvidence.fileSha256,
  sourceEvidenceBodySha256: sourceEvidence.evidence.evidenceSha256,
  bootstrapIdentitySha256: deploymentIdentity.bootstrapIdentitySha256,
  bootstrapCatalogId,
  bootstrapObjectiveMode: bootstrapSpecificationEvidence.mode,
  bootstrapSpecificationsSha256:
    bootstrapSpecificationEvidence.specificationsSha256 ?? null,
  deployer: account.address,
  policyActivationAuthority,
  thresholdAuthorityOwners: thresholdAuthority.owners,
  thresholdAuthorityThreshold: thresholdAuthority.threshold,
  deployerHasRuntimeAuthority: false,
  features: {
    runtimeCapabilityPerformance: true,
    selfReportedPerformanceRanking: false,
  },
  genesisStart: releaseInputs.genesisStart,
  genesisRelease: releaseInputs.genesisRelease,
  genesisModuleHash: releaseInputs.genesisModuleHash,
  genesisManifestHash: releaseInputs.genesisManifestHash,
  financeInvariantHash,
  bootstrapVerifierCodehash: verifierCodehash,
  bootstrap: redactBootstrapSecrets(state.bootstrap),
  token: config.token,
  emission: config.emission,
  dynamicIssues: config.dynamicIssues,
  consensus: config.consensus,
  contracts: state.contracts,
  artifactBytecode: artifacts,
  deployedCodeHashes,
  deploymentTransactions: state.deploymentTransactions,
  creationInputHashes: state.creationInputHashes,
  configurationTransactions: state.configurationTransactions,
  configurationInputHashes: state.configurationInputHashes,
  transactionIntents: state.transactionIntents,
  transactionHashes: state.transactionHashes,
  gasUsed: gasUsed.toString(),
  deployedAt: new Date().toISOString(),
};
const manifest = profile.testnetOnly
  ? {
      ...commonManifest,
      schema: profile.manifestSchema,
      release: VERSION,
      sourceEvidenceSha256:
        sourceEvidence.evidence.evidenceSha256,
      deploymentBlock,
      bootstrapRoot: state.bootstrap.issueRoot,
      dynamicValidatorRoot: state.bootstrap.validatorRoot,
      artifactTypes: { ...CONTRACT_TYPES },
      artifactCreationBytecodeHashes: Object.fromEntries(
        Object.entries(artifacts).map(([type, evidence]) => [
          type,
          evidence.creationBytecodeHash,
        ]),
      ),
    }
  : commonManifest;
manifest.manifestSha256 = sha256Json(manifest);
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (profile.testnetOnly && profile.historicalSourceEvidencePath) {
  fs.copyFileSync(sourceEvidencePath, profile.historicalSourceEvidencePath);
}
if (
  profile.testnetOnly &&
  bootstrapSpecificationEvidence.specificationsPath &&
  profile.historicalBootstrapSpecificationsPath
) {
  fs.copyFileSync(
    bootstrapSpecificationEvidence.specificationsPath,
    profile.historicalBootstrapSpecificationsPath,
  );
}
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      version: VERSION,
      deploymentProfile: profile.id,
      testnetOnly: profile.testnetOnly,
      network: profile.network,
      chainId: profile.chainId,
      phase: "BOOTSTRAP",
      sourceCommit: releaseInputs.sourceCommit,
      contracts: manifest.contracts,
      transactionCount: manifest.transactionHashes.length,
      gasUsed: manifest.gasUsed,
      remainingEth: formatEther(
        await client.getBalance({ address: account.address }),
      ),
      manifestPath,
      manifestSha256: manifest.manifestSha256,
    },
    null,
    2,
  )}\n`,
);
