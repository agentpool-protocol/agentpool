import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  CHAIN_ID,
  NETWORK,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  artifactBytecodeEvidence,
  assertTrackedTreeClean,
  buildBootstrapTerms,
  collectReleaseInputs,
  loadAndValidateConfig,
  loadAndValidateGates,
  requireEnv,
  serializeIssue,
  sha256Json,
} from "./lib/v44-mainnet.mjs";

const manifestPath = path.join(ROOT, "deployments", "8453.v44.json");
const partialPath = path.join(ROOT, "deployments", "8453.v44.partial.json");
if (fs.existsSync(manifestPath)) throw new Error("V44_ALREADY_DEPLOYED");

assertTrackedTreeClean();
const configEvidence = loadAndValidateConfig();
const gateEvidence = loadAndValidateGates();
const config = configEvidence.config;
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const releaseInputs = collectReleaseInputs({
  deployerAddress: account.address,
});
const rpcUrl = requireEnv("AGENTPOOL_MAINNET_RPC_URL");
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: base, transport });
const wallet = createWalletClient({ account, chain: base, transport });
const actualChainId = await client.getChainId();
if (actualChainId !== CHAIN_ID) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V44_DEPLOYER_BALANCE_WEI ?? "10000000000000000",
);
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
  chainId: CHAIN_ID,
  sourceCommit: releaseInputs.sourceCommit,
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence.gatesSha256,
  deployer: account.address,
  genesisStart: releaseInputs.genesisStart,
  genesisRelease: releaseInputs.genesisRelease,
};
if (existingPartial) {
  for (const [key, expected] of Object.entries(deploymentIdentity)) {
    const actual = existingPartial[key];
    const same =
      typeof expected === "string" && typeof actual === "string"
        ? expected.toLowerCase() === actual.toLowerCase()
        : expected === actual;
    if (!same) throw new Error(`V44_PARTIAL_IDENTITY_MISMATCH:${key}`);
  }
}

const state = existingPartial ?? {
  ...deploymentIdentity,
  network: NETWORK,
  contracts: {},
  transactionHashes: [],
  gasUsed: "0",
};
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

async function deploy(name, args, key) {
  if (state.contracts[key]) {
    await assertCode(state.contracts[key], key);
    return getAddress(state.contracts[key]);
  }
  const compiled = artifact(name);
  const hash = await wallet.deployContract({
    account,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  state.transactionHashes.push(hash);
  savePartial();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name}_DEPLOYMENT_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  state.contracts[key] = getAddress(receipt.contractAddress);
  savePartial();
  return state.contracts[key];
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
  if (configured) return null;
  const simulation = await client.simulateContract({
    account,
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(simulation.request);
  state.transactionHashes.push(hash);
  savePartial();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`${name}.${functionName}_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  savePartial();
  return hash;
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
  deliveryHash: releaseInputs.bootstrap.deliveryHash,
  objectiveProof: releaseInputs.bootstrap.objectiveProof,
};
savePartial();

const systemIssueGate = await deploy(
  "AgentPoolV435SystemIssueGate",
  [
    bootstrap.issueRoot,
    contributionLedger,
    account.address,
    verifierCodehash,
    bootstrap.validatorRoot,
    dynamicCandidateBudgetCap,
    dynamicIssueBudgetCap,
    config.dynamicIssues.maxCandidates,
    config.dynamicIssues.maxLifetimeSeconds,
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
const manifest = {
  schema: "agentpool.mainnet.v44.deployment/v1",
  version: VERSION,
  chainId: CHAIN_ID,
  network: NETWORK,
  phase: "BOOTSTRAP",
  sourceCommit: releaseInputs.sourceCommit,
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence.gatesSha256,
  approvedGateEvidence: gateEvidence.approved,
  deployer: account.address,
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
  bootstrap: state.bootstrap,
  token: config.token,
  emission: config.emission,
  dynamicIssues: config.dynamicIssues,
  consensus: config.consensus,
  contracts: state.contracts,
  artifactBytecode: artifacts,
  deployedCodeHashes,
  transactionHashes: state.transactionHashes,
  gasUsed: gasUsed.toString(),
  deployedAt: new Date().toISOString(),
};
manifest.manifestSha256 = sha256Json(manifest);
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      version: VERSION,
      network: NETWORK,
      chainId: CHAIN_ID,
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
