import fs from "node:fs";
import path from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const manifestPath = path.join(root, "deployments", "84532.v43.4.json");
const partialPath = path.join(root, "deployments", "84532.v43.4.partial.json");
if (fs.existsSync(manifestPath)) throw new Error("V43_ALREADY_DEPLOYED");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}
function requireAddress(name) {
  const value = requireEnv(name);
  if (!isAddress(value)) throw new Error(`${name}_INVALID`);
  return getAddress(value);
}
function pairHash(left, right) {
  return keccak256(
    left.toLowerCase() < right.toLowerCase()
      ? concatHex([left, right])
      : concatHex([right, left]),
  );
}
function merkleRoot(leaves) {
  if (leaves.length === 0) throw new Error("V432_EMPTY_MERKLE_TREE");
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(pairHash(level[index], level[index + 1] ?? level[index]));
    }
    level = next;
  }
  return level[0];
}
function merkleCatalog(leaves) {
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
      for (let depth = 0; depth < layers.length - 1; depth++) {
        const level = layers[depth];
        proof.push(level[index ^ 1] ?? level[index]);
        index = Math.floor(index / 2);
      }
      return proof;
    }),
  };
}

const chainId = 84532;
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
if ((await client.getChainId()) !== chainId) throw new Error("V43_CHAIN_MISMATCH");

const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V43_DEPLOYER_BALANCE_WEI ?? "100000000000000",
);
if (balance < minimumBalance) {
  throw new Error(
    `V43_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
  );
}

const existingPartial = fs.existsSync(partialPath)
  ? JSON.parse(fs.readFileSync(partialPath, "utf8"))
  : null;
const now = Math.floor(Date.now() / 1_000);
const genesisStart =
  existingPartial?.genesisStart ??
  Number(process.env.V434_GENESIS_TIMESTAMP ?? now + 3_600);
if (!Number.isSafeInteger(genesisStart)) {
  throw new Error("V43_GENESIS_TIMESTAMP_INVALID");
}
if (
  !existingPartial &&
  (genesisStart < now + 300 || genesisStart > now + 14_400)
) {
  throw new Error("V43_GENESIS_TIMESTAMP_MUST_BE_5_TO_240_MINUTES_AHEAD");
}

const financeInvariantHash = keccak256(
  toBytes(
    "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout|receipt-replay",
  ),
);
const genesisRelease = keccak256(toBytes("agentpool-v4.3-genesis"));
const genesisModuleHash = keccak256(toBytes("agentpool-v4.3-genesis-module"));
const genesisManifestHash = keccak256(toBytes("agentpool-v4.3-genesis-manifest"));
const proposalBond = parseEther("10");
const coreWeeklyCap = parseEther("63000");
const evolutionWeeklyCap = parseEther("7000");
const coreLifetimeCap = parseEther("900000000000");
const evolutionLifetimeCap = parseEther("100000000000");

const state = existingPartial ?? {
  version: "4.3.4-bootstrap-alpha",
  chainId,
  network: "Base Sepolia",
  deployer: account.address,
  genesisStart,
  financeInvariantHash,
  genesisRelease,
  contracts: {},
  transactionHashes: [],
  gasUsed: "0",
};
if (state.deployer.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error("V43_PARTIAL_DEPLOYER_MISMATCH");
}
let gasUsed = BigInt(state.gasUsed ?? "0");

function savePartial() {
  state.gasUsed = gasUsed.toString();
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function assertCode(address, label) {
  const code = await readCodeWithRetry(address);
  if (!code || code === "0x") throw new Error(`V43_MISSING_CODE:${label}`);
  return code;
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

async function deploy(name, args, key) {
  if (state.contracts[key]) {
    await assertCode(state.contracts[key], key);
    return state.contracts[key];
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
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name}_DEPLOYMENT_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  state.contracts[key] = receipt.contractAddress;
  savePartial();
  return receipt.contractAddress;
}

async function write(name, address, functionName, args, configured) {
  if (configured) return;
  const hash = await wallet.writeContract({
    account,
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  state.transactionHashes.push(hash);
  savePartial();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`${name}.${functionName}_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  savePartial();
}

const token = await deploy("AgentPoolV43Token", [account.address], "token");
const settlementRouter = await deploy(
  "AgentPoolV43SettlementRouter",
  [account.address],
  "settlementRouter",
);
const releaseRegistry = await deploy(
  "AgentPoolV43ReleaseRegistry",
  [
    genesisRelease,
    genesisModuleHash,
    genesisManifestHash,
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
const coreVault = await deploy(
  "AgentPoolV43EpochVault",
  [
    token,
    keccak256(toBytes("CORE")),
    genesisStart,
    coreWeeklyCap,
    coreLifetimeCap,
    account.address,
  ],
  "coreEpochVault",
);
const evolutionVault = await deploy(
  "AgentPoolV43EpochVault",
  [
    token,
    keccak256(toBytes("EVOLUTION")),
    genesisStart,
    evolutionWeeklyCap,
    evolutionLifetimeCap,
    account.address,
  ],
  "evolutionEpochVault",
);
const ledger = await deploy(
  "AgentPoolV43ContributionLedger",
  [genesisStart, settlementRouter, account.address],
  "contributionLedger",
);
const proofRegistry = await deploy(
  "AgentPoolV432ProofRegistry",
  [ledger, account.address],
  "proofRegistry",
);
const consensus = await deploy(
  "AgentPoolV43EvolutionConsensus",
  [
    token,
    ledger,
    releaseRegistry,
    financeInvariantHash,
    genesisRelease,
    proposalBond,
  ],
  "evolutionConsensus",
);
const verifier = await deploy(
  "AgentPoolV43HashObjectiveVerifier",
  [],
  "objectiveVerifier",
);
const verifierCode = await readCodeWithRetry(verifier);
if (!verifierCode || verifierCode === "0x") {
  throw new Error("V43_VERIFIER_CODE_MISSING");
}
const verifierCodehash = keccak256(verifierCode);
state.bootstrapVerifierCodehash = verifierCodehash;
savePartial();
const bootstrapCapability = keccak256(
  toBytes("agentpool-system-improvement"),
);
const bootstrapSpecificationHash = keccak256(
  toBytes("v432-public-chain-mcp-indexer-adversarial-readiness"),
);
const bootstrapDeliveryHash = keccak256(
  toBytes("v432-system-improvement-smoke-delivery"),
);
const bootstrapObjectiveProof = toHex(
  "agentpool-v432-objective-system-proof",
);
const bootstrapEvidenceHash = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      bootstrapSpecificationHash,
      bootstrapDeliveryHash,
      keccak256(bootstrapObjectiveProof),
    ],
  ),
);
const validatorEntries = [
  requireAddress("VALIDATOR_1"),
  requireAddress("VALIDATOR_2"),
  requireAddress("VALIDATOR_3"),
].map((address, index) => ({
  address,
  group: keccak256(toBytes(`bootstrap-validator-group-${index + 1}`)),
}));
if (new Set(validatorEntries.map((entry) => entry.address.toLowerCase())).size !== 3) {
  throw new Error("V432_BOOTSTRAP_VALIDATORS_NOT_DISTINCT");
}
const validatorLeaves = validatorEntries.map((entry) => {
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
const bootstrapObjectiveInner = keccak256(
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
      verifier,
      bootstrapCapability,
      bootstrapSpecificationHash,
      bootstrapEvidenceHash,
      3,
      8_000,
      60,
      60,
      validatorCatalog.root,
      3,
    ],
  ),
);
const bootstrapObjectiveRoot = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }],
    [bootstrapObjectiveInner],
  ),
);
const bootstrapIssue = {
  issueId: keccak256(toBytes("AGENTPOOL_V434_BOOTSTRAP_PUBLIC_INTEGRATION")),
  bootstrapProposer: account.address,
  specificationHash: bootstrapSpecificationHash,
  verifier,
  expectedEvidenceHash: bootstrapEvidenceHash,
  objectiveRoot: bootstrapObjectiveRoot,
  validatorRoot: validatorCatalog.root,
  candidateBudgetCap: parseEther("120"),
  totalBudgetCap: parseEther("120"),
  maxCandidates: 1,
  minimumReveals: 3,
  passScoreBps: 8_000,
  minimumValidatorGroups: 3,
  funding: 3,
  expiresAt: genesisStart + 30 * 86_400,
};
const bootstrapIssueRoot = keccak256(
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
    [bootstrapIssue],
  ),
);
const bootstrapIssueManifest = {
  ...bootstrapIssue,
  candidateBudgetCap: bootstrapIssue.candidateBudgetCap.toString(),
  totalBudgetCap: bootstrapIssue.totalBudgetCap.toString(),
};
state.bootstrapIssue = bootstrapIssueManifest;
state.bootstrapIssueRoot = bootstrapIssueRoot;
state.bootstrapObjective = {
  capability: bootstrapCapability,
  deliveryHash: bootstrapDeliveryHash,
  proof: bootstrapObjectiveProof,
  objectiveRoot: bootstrapObjectiveRoot,
};
state.bootstrapValidators = validatorEntries.map((entry, index) => ({
  ...entry,
  proof: validatorCatalog.proofs[index],
}));
savePartial();
const systemIssueGate = await deploy(
  "AgentPoolV432SystemIssueGate",
  [bootstrapIssueRoot, ledger, account.address],
  "systemIssueGate",
);
const issueConsensus = await deploy(
  "AgentPoolV432IssueConsensus",
  [token, ledger, systemIssueGate, proposalBond],
  "issueConsensus",
);
const taskMarket = await deploy(
  "AgentPoolV432TaskMarket",
  [
    token,
    userEscrow,
    coreVault,
    evolutionVault,
    ledger,
    releaseRegistry,
    capacityRegistry,
    proofRegistry,
    settlementRouter,
    systemIssueGate,
    financeInvariantHash,
  ],
  "taskMarket",
);

const zero = "0x0000000000000000000000000000000000000000";
await write(
  "AgentPoolV43Token",
  token,
  "configureMinters",
  [coreVault, evolutionVault],
  (await client.readContract({
    address: token,
    abi: artifact("AgentPoolV43Token").abi,
    functionName: "configurationAuthority",
  })) === zero,
);
for (const address of [coreVault, evolutionVault]) {
  await write(
    "AgentPoolV43EpochVault",
    address,
    "configureMarket",
    [taskMarket],
    (await client.readContract({
      address,
      abi: artifact("AgentPoolV43EpochVault").abi,
      functionName: "market",
    })) !== zero,
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
    (await client.readContract({
      address,
      abi: artifact(name).abi,
      functionName: "market",
    })) !== zero,
  );
}
await write(
  "AgentPoolV43ContributionLedger",
  ledger,
  "configureConsensus",
  [consensus],
  (await client.readContract({
    address: ledger,
    abi: artifact("AgentPoolV43ContributionLedger").abi,
    functionName: "consensus",
  })) !== zero,
);
await write(
  "AgentPoolV43ReleaseRegistry",
  releaseRegistry,
  "configureConsensus",
  [consensus],
  (await client.readContract({
    address: releaseRegistry,
    abi: artifact("AgentPoolV43ReleaseRegistry").abi,
    functionName: "consensus",
  })) !== zero,
);
await write(
  "AgentPoolV43SettlementRouter",
  settlementRouter,
  "configure",
  [ledger, consensus, taskMarket],
  (await client.readContract({
    address: settlementRouter,
    abi: artifact("AgentPoolV43SettlementRouter").abi,
    functionName: "market",
  })) !== zero,
);
await write(
  "AgentPoolV432SystemIssueGate",
  systemIssueGate,
  "configure",
  [taskMarket, issueConsensus],
  (await client.readContract({
    address: systemIssueGate,
    abi: artifact("AgentPoolV432SystemIssueGate").abi,
    functionName: "market",
  })) !== zero,
);

const manifest = {
  version: "4.3.4-bootstrap-alpha",
  chainId,
  network: "Base Sepolia",
  phase: "BOOTSTRAP",
  deployer: account.address,
  deployerHasRuntimeAuthority: false,
  genesisStart,
  financeInvariantHash,
  genesisRelease,
  bootstrapVerifierCodehash: verifierCodehash,
  bootstrapIssueRoot,
  bootstrapObjective: state.bootstrapObjective,
  bootstrapValidators: state.bootstrapValidators,
  bootstrapIssues: [{ ...bootstrapIssueManifest, proof: [] }],
  supersedesTestDeployments: [
    "deployments/84532.v43.json",
    "deployments/84532.v43.1.json",
    "deployments/84532.v43.2.json",
    "deployments/84532.v43.3.json",
  ],
  token: {
    symbol: "tAPOOL",
    decimals: 18,
    maxSupplyApool: "1000000000000",
    premintApool: "0",
  },
  emission: {
    epochSeconds: 604800,
    coreWeeklyCapApool: "63000",
    evolutionWeeklyCapApool: "7000",
    coreLifetimeCapApool: "900000000000",
    evolutionLifetimeCapApool: "100000000000",
  },
  maturity: {
    eligibleAgents: 5,
    independentOperatorGroups: 3,
    successfulSettlements: 50,
    activeEpochs: 2,
    maximumSingleGroupShareBps: 5000,
  },
  contracts: state.contracts,
  transactionHashes: state.transactionHashes,
  gasUsed: gasUsed.toString(),
  deployedAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    network: "Base Sepolia",
    chainId,
    phase: "BOOTSTRAP",
    contracts: manifest.contracts,
    transactions: manifest.transactionHashes.length,
    gasUsed: manifest.gasUsed,
    remainingTestEth: formatEther(
      await client.getBalance({ address: account.address }),
    ),
  })}\n`,
);
