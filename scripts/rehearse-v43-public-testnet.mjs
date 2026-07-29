import fs from "node:fs";
import path from "node:path";
import { createBlock } from "@ethereumjs/block";
import { Common, Hardfork, Mainnet, createCustomCommon } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import {
  bytesToHex,
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
} from "@ethereumjs/util";
import { createVM, runTx } from "@ethereumjs/vm";
import {
  decodeFunctionResult,
  concatHex,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";

const root = process.cwd();
const tokenArtifactName =
  process.env.AGENTPOOL_REHEARSAL_TOKEN_ARTIFACT ?? "AgentPoolV43Token";
const rehearsalOutputName =
  process.env.AGENTPOOL_REHEARSAL_OUTPUT ??
  "v43-public-testnet-rehearsal.json";
const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v4.3 Public Testnet Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("LOCAL_EVM_COMMON_FAILED");
const vm = await createVM({ common, activatePrecompiles: true });

function keyFor(index) {
  return hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
}
function addressFor(key) {
  return getAddress(createAddressFromPrivateKey(key).toString());
}

const deployerKey = keyFor(1);
const deployer = addressFor(deployerKey);
const agents = Array.from({ length: 8 }, (_, index) => {
  const key = keyFor(index + 2);
  return { key, address: addressFor(key) };
});
for (const key of [deployerKey, ...agents.map((agent) => agent.key)]) {
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(key),
    createAccount({ nonce: 0n, balance: parseEther("10000") }),
  );
}

const artifactCache = new Map();
function artifact(name) {
  const resolvedName =
    name === "AgentPoolV43Token" ? tokenArtifactName : name;
  if (!artifactCache.has(resolvedName)) {
    artifactCache.set(
      resolvedName,
      JSON.parse(
        fs.readFileSync(
          path.join(root, "artifacts", `${resolvedName}.json`),
          "utf8",
        ),
      ),
    );
  }
  return artifactCache.get(resolvedName);
}

let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1_000));
let transactionCount = 0;
let gasSpent = 0n;
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
  if (!passed) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

async function execute(data, to, signingKey = deployerKey) {
  const signer = createAddressFromPrivateKey(signingKey);
  const account = await vm.stateManager.getAccount(signer);
  const tx = createLegacyTx(
    {
      nonce: account?.nonce ?? 0n,
      gasPrice: 1_000_000_000n,
      gasLimit: 30_000_000n,
      to: to ? createAddressFromString(to) : undefined,
      value: 0n,
      data: hexToBytes(data),
    },
    { common },
  ).sign(signingKey);
  const block = createBlock(
    {
      header: {
        number: blockNumber,
        timestamp: blockTimestamp,
        gasLimit: 100_000_000n,
      },
    },
    { common, skipConsensusFormatValidation: true },
  );
  const result = await runTx(vm, {
    tx,
    block,
    skipBlockGasLimitValidation: true,
  });
  blockNumber++;
  blockTimestamp++;
  transactionCount++;
  gasSpent += result.totalGasSpent;
  if (result.execResult.exceptionError) {
    throw new Error(
      `LOCAL_EVM_REVERT:${result.execResult.exceptionError.error}:${bytesToHex(result.execResult.returnValue)}`,
    );
  }
  return result;
}

async function deploy(name, args = []) {
  const compiled = artifact(name);
  const result = await execute(
    encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args }),
  );
  if (!result.createdAddress) throw new Error(`${name}_DEPLOYMENT_FAILED`);
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0 || code.length > 24_576) {
    throw new Error(`${name}_INVALID_CODE_SIZE:${code.length}`);
  }
  return getAddress(result.createdAddress.toString());
}

async function write(name, address, functionName, args = [], key = deployerKey) {
  return execute(
    encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    address,
    key,
  );
}

async function read(name, address, functionName, args = []) {
  const caller = createAddressFromPrivateKey(deployerKey);
  const result = await vm.evm.runCall({
    caller,
    origin: caller,
    to: createAddressFromString(address),
    data: hexToBytes(
      encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    ),
    gasLimit: 30_000_000n,
    isStatic: true,
  });
  if (result.execResult.exceptionError) {
    throw new Error(`${name}.${functionName}_STATIC_REVERT`);
  }
  return decodeFunctionResult({
    abi: artifact(name).abi,
    functionName,
    data: bytesToHex(result.execResult.returnValue),
  });
}

async function expectRevert(name, action) {
  try {
    await action();
  } catch {
    checks.push({ name, passed: true, actual: "reverted", expected: "reverted" });
    return;
  }
  throw new Error(`${name}_UNEXPECTEDLY_SUCCEEDED`);
}

const financeInvariantHash = keccak256(
  toBytes(
    "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout|receipt-replay",
  ),
);
const genesisRelease = keccak256(toBytes("agentpool-v4.3-genesis"));
const capability = keccak256(toBytes("deterministic-data"));
const genesisModuleHash = keccak256(toBytes("agentpool-v4.3-genesis-module"));
const genesisManifestHash = keccak256(toBytes("agentpool-v4.3-genesis-manifest"));
const proposalBond = parseEther("10");
const genesisStart = Number(blockTimestamp + 30n);

const token = await deploy("AgentPoolV43Token", [deployer]);
const settlementRouter = await deploy("AgentPoolV43SettlementRouter", [deployer]);
const releaseRegistry = await deploy("AgentPoolV43ReleaseRegistry", [
  genesisRelease,
  genesisModuleHash,
  genesisManifestHash,
  deployer,
]);
const capacityRegistry = await deploy("AgentPoolV43CapacityRegistry", [deployer]);
const userEscrow = await deploy("AgentPoolV43UserEscrowKernel", [token, deployer]);
const coreVault = await deploy("AgentPoolV43EpochVault", [
  token,
  keccak256(toBytes("CORE")),
  genesisStart,
  parseEther("63000"),
  parseEther("900000000000"),
  deployer,
]);
const evolutionVault = await deploy("AgentPoolV43EpochVault", [
  token,
  keccak256(toBytes("EVOLUTION")),
  genesisStart,
  parseEther("7000"),
  parseEther("100000000000"),
  deployer,
]);
const ledger = await deploy("AgentPoolV43ContributionLedger", [
  genesisStart,
  settlementRouter,
  deployer,
]);
const proofRegistry = await deploy("AgentPoolV432ProofRegistry", [
  ledger,
  deployer,
]);
const consensus = await deploy("AgentPoolV43EvolutionConsensus", [
  token,
  ledger,
  releaseRegistry,
  financeInvariantHash,
  genesisRelease,
  proposalBond,
]);
const verifier = await deploy("AgentPoolV43HashObjectiveVerifier");
function issueTermsHash(issue) {
  return keccak256(
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
}

function objectiveLeaf(term, policy) {
  const inner = keccak256(
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
        term.verifier,
        term.capability,
        term.specificationHash,
        term.expectedEvidenceHash,
        term.capacityUnits,
        term.minimumReveals,
        term.passScoreBps,
        term.commitWindow,
        term.revealWindow,
        policy.validatorRoot,
        policy.minimumOperatorGroups,
      ],
    ),
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32" }], [inner]));
}

function evidenceFor(label, specificationHash) {
  const deliveryHash = keccak256(toBytes(`${label}-delivery`));
  const proof = toHex(`${label}-proof`);
  return {
    deliveryHash,
    proof,
    expectedEvidenceHash: keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [specificationHash, deliveryHash, keccak256(proof)],
      ),
    ),
  };
}

function issueFor(label, funding = 3, capacityUnits = 1) {
  const specificationHash = keccak256(
    toBytes(`${label}-specification`),
  );
  const evidence = evidenceFor(label, specificationHash);
  const defaultPolicy = {
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
  };
  const defaultObjective = {
    verifier,
    capability,
    specificationHash,
    expectedEvidenceHash: evidence.expectedEvidenceHash,
    capacityUnits,
    minimumReveals: 0,
    passScoreBps: 0,
    commitWindow: 0,
    revealWindow: 0,
  };
  return {
    issueId: keccak256(toBytes(`issue:${label}`)),
    bootstrapProposer: agents[5].address,
    specificationHash,
    verifier,
    expectedEvidenceHash: evidence.expectedEvidenceHash,
    objectiveRoot: objectiveLeaf(defaultObjective, defaultPolicy),
    validatorRoot: `0x${"00".repeat(32)}`,
    candidateBudgetCap: parseEther("1000"),
    totalBudgetCap: parseEther("1000"),
    maxCandidates: 1,
    minimumReveals: 0,
    passScoreBps: 0,
    minimumValidatorGroups: 0,
    funding,
    expiresAt: genesisStart + 180 * 86_400,
  };
}

function pairHash(left, right) {
  return keccak256(
    left.toLowerCase() < right.toLowerCase()
      ? concatHex([left, right])
      : concatHex([right, left]),
  );
}

function merkleCatalog(entries) {
  return merkleFromLeaves(entries.map(issueTermsHash));
}

function merkleFromLeaves(leaves) {
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const level = layers.at(-1);
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(pairHash(level[index], level[index + 1] ?? level[index]));
    }
    layers.push(next);
  }
  const proofs = new Map();
  leaves.forEach((leaf, originalIndex) => {
    let index = originalIndex;
    const proof = [];
    for (let depth = 0; depth < layers.length - 1; depth++) {
      const level = layers[depth];
      proof.push(level[index ^ 1] ?? level[index]);
      index = Math.floor(index / 2);
    }
    proofs.set(leaf, proof);
  });
  return { root: layers.at(-1)[0], proofs };
}

function validatorLeaf(address, group) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [address, group],
    ),
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32" }], [inner]));
}

const bootstrapLabels = [
  "bootstrap-improvement",
  ...Array.from({ length: 23 }, (_, index) => `epoch-zero-${index}`),
  ...Array.from({ length: 25 }, (_, index) => `epoch-one-${index}`),
  ...Array.from({ length: 5 }, (_, index) => `candidate-adoption-${index}`),
];
const bootstrapIssues = bootstrapLabels.map((label) =>
  issueFor(label, 3, label === "bootstrap-improvement" ? 5 : 1),
);
const bootstrapIssueByLabel = new Map(
  bootstrapLabels.map((label, index) => [label, bootstrapIssues[index]]),
);
const bootstrapCatalog = merkleCatalog(bootstrapIssues);
const bootstrapIssue = bootstrapIssues[0];
const dynamicValidatorEntries = agents.slice(0, 4).map((agent, index) => ({
  ...agent,
  group: keccak256(toBytes(`operator-group-${index}`)),
}));
const dynamicValidatorCatalog = merkleFromLeaves(
  dynamicValidatorEntries.map((entry) =>
    validatorLeaf(entry.address, entry.group),
  ),
);
const evolvedValidatorEntries = [1, 2, 3, 5].map((agentIndex) => ({
  ...agents[agentIndex],
  group: keccak256(toBytes(`operator-group-${agentIndex % 4}`)),
}));
const evolvedValidatorCatalog = merkleFromLeaves(
  evolvedValidatorEntries.map((entry) =>
    validatorLeaf(entry.address, entry.group),
  ),
);
const verifierRuntimeCode = await vm.stateManager.getCode(
  createAddressFromString(verifier),
);
const dynamicVerifierCodehash = keccak256(bytesToHex(verifierRuntimeCode));
const systemIssueGate = await deploy("AgentPoolV435SystemIssueGate", [
  bootstrapCatalog.root,
  ledger,
  deployer,
  dynamicVerifierCodehash,
  dynamicValidatorCatalog.root,
  parseEther("10"),
  parseEther("30"),
  3,
  60 * 86_400,
]);
const transitionIssueConsensus = await deploy(
  "AgentPoolV435TransitionIssueConsensus",
  [
    token,
    ledger,
    systemIssueGate,
    proposalBond,
  ],
);
const issueConsensus = await deploy("AgentPoolV432IssueConsensus", [
  token,
  ledger,
  systemIssueGate,
  proposalBond,
]);
const market = await deploy("AgentPoolV432TaskMarket", [
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
]);

function dynamicIssueFor(
  label,
  funding = 3,
  validatorCatalog = dynamicValidatorCatalog,
) {
  const specificationHash = keccak256(
    toBytes(`${label}-specification`),
  );
  const evidence = evidenceFor(label, specificationHash);
  const policy = {
    validatorRoot: validatorCatalog.root,
    minimumOperatorGroups: 3,
  };
  const objective = {
    verifier,
    capability,
    specificationHash,
    expectedEvidenceHash: evidence.expectedEvidenceHash,
    capacityUnits: 2,
    minimumReveals: 3,
    passScoreBps: 9_000,
    commitWindow: 60,
    revealWindow: 60,
  };
  return {
    issueId: keccak256(toBytes(`dynamic-issue:${label}`)),
    bootstrapProposer: "0x0000000000000000000000000000000000000000",
    specificationHash,
    verifier,
    expectedEvidenceHash: evidence.expectedEvidenceHash,
    objectiveRoot: objectiveLeaf(objective, policy),
    validatorRoot: validatorCatalog.root,
    candidateBudgetCap: parseEther("10"),
    totalBudgetCap: parseEther("30"),
    maxCandidates: 3,
    minimumReveals: 3,
    passScoreBps: 9_000,
    minimumValidatorGroups: 3,
    funding,
    expiresAt: Number(blockTimestamp + 60n * 86_400n),
  };
}

await write("AgentPoolV43Token", token, "configureMinters", [
  coreVault,
  evolutionVault,
]);
await write("AgentPoolV43EpochVault", coreVault, "configureMarket", [market]);
await write("AgentPoolV43EpochVault", evolutionVault, "configureMarket", [market]);
await write("AgentPoolV43UserEscrowKernel", userEscrow, "configureMarket", [
  market,
]);
await write("AgentPoolV43CapacityRegistry", capacityRegistry, "configureMarket", [
  market,
]);
await write("AgentPoolV432ProofRegistry", proofRegistry, "configureMarket", [
  market,
]);
await write("AgentPoolV43ContributionLedger", ledger, "configureConsensus", [
  consensus,
]);
await write("AgentPoolV43ReleaseRegistry", releaseRegistry, "configureConsensus", [
  consensus,
]);
await write("AgentPoolV43SettlementRouter", settlementRouter, "configure", [
  ledger,
  consensus,
  market,
]);
await write(
  "AgentPoolV435SystemIssueGate",
  systemIssueGate,
  "configure",
  [market, transitionIssueConsensus, issueConsensus],
);

check(
  "token minter configuration is ownerless",
  await read("AgentPoolV43Token", token, "configurationAuthority"),
  "0x0000000000000000000000000000000000000000",
);
check(
  "external escrow configuration is ownerless",
  await read("AgentPoolV43UserEscrowKernel", userEscrow, "configurationAuthority"),
  "0x0000000000000000000000000000000000000000",
);
check(
  "settlement router is the active genesis source",
  await read("AgentPoolV43ContributionLedger", ledger, "isActiveSource", [
    settlementRouter,
  ]),
  true,
);
check(
  "testnet starts in BOOTSTRAP",
  await read("AgentPoolV43ContributionLedger", ledger, "mature"),
  false,
);
check(
  "dynamic Issue approval is closed before TRANSITION",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "transitionReady",
  ),
  false,
);

blockTimestamp = BigInt(genesisStart + 1);
for (let index = 0; index < 6; index++) {
  await write(
    "AgentPoolV43ContributionLedger",
    ledger,
    "register",
    [
      // Four groups let a worker be excluded while a three-group validator
      // panel remains possible.
      keccak256(toBytes(`operator-group-${index % 4}`)),
      keccak256(toBytes(`runtime-${index}`)),
    ],
    agents[index].key,
  );
  await write(
    "AgentPoolV43CapacityRegistry",
    capacityRegistry,
    "publish",
    [
      capability,
      64,
      Number(blockTimestamp + 30n * 86_400n),
      keccak256(toBytes(`runtime-${index}`)),
    ],
    agents[index].key,
  );
}

function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}

function jobIdFor(creator, nonce, planHash) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [31337n, market, creator, nonce, planHash],
    ),
  );
}

async function settleJob({
  funding,
  creatorKey = deployerKey,
  workerIndex,
  releaseId,
  allocation,
  keeperFee,
  capacityUnits,
  label,
  issue = bootstrapIssueByLabel.get(label) ?? bootstrapIssue,
  jobCapability = capability,
}) {
  const worker = agents[workerIndex];
  const effectiveCreatorKey =
    funding === 1 || creatorKey !== deployerKey
      ? creatorKey
      : funding === 3
        ? agents[5].key
        : agents[(workerIndex + 1) % 5].key;
  const creator = addressFor(effectiveCreatorKey);
  const planHash = keccak256(toBytes(`${label}-plan`));
  const specificationHash =
    funding === 1
      ? keccak256(toBytes(`${label}-specification`))
      : issue.specificationHash;
  const { deliveryHash, proof, expectedEvidenceHash } =
    evidenceFor(label, specificationHash);
  const recipients = [worker.address];
  const amounts = [allocation];
  const budget = allocation + keeperFee + parseEther("1");
  const nonce = await read("AgentPoolV432TaskMarket", market, "nextJobNonce");
  const jobId = jobIdFor(creator, nonce, planHash);
  const terms = [
    {
      worker: worker.address,
      verifier,
      capability: jobCapability,
      specificationHash,
      expectedEvidenceHash,
      payoutRoot: payoutRoot(recipients, amounts),
      allocation,
      workerBond: 0n,
      keeperFee,
      deadline: Number(blockTimestamp + 86_400n),
      capacityUnits,
      minimumReveals: 0,
      passScoreBps: 0,
      commitWindow: 0,
      revealWindow: 0,
    },
  ];
  const policies = [
    {
      validatorRoot: `0x${"00".repeat(32)}`,
      minimumOperatorGroups: 0,
    },
  ];
  if (funding === 1) {
    await write(
      "AgentPoolV43Token",
      token,
      "approve",
      [userEscrow, budget],
      effectiveCreatorKey,
    );
    await write(
      "AgentPoolV432TaskMarket",
      market,
      "createExternalJobV2",
      [budget, planHash, releaseId, terms, policies, [0]],
      effectiveCreatorKey,
    );
  } else {
    const issueHash = issueTermsHash(issue);
    const bootstrapProof =
      funding === 3 && bootstrapCatalog.proofs.has(issueHash)
        ? bootstrapCatalog.proofs.get(issueHash)
        : [];
    await write(
      "AgentPoolV432TaskMarket",
      market,
      "createSystemJobV2",
      [
        funding,
        budget,
        planHash,
        releaseId,
        issue,
        bootstrapProof,
        terms,
        policies,
        [0],
        [[]],
      ],
      effectiveCreatorKey,
    );
  }
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "acceptMilestone",
    [jobId, 0],
    worker.key,
  );
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "deliver",
    [jobId, 0, deliveryHash],
    worker.key,
  );
  await write("AgentPoolV432TaskMarket", market, "resolve", [
    jobId,
    0,
    proof,
    recipients,
    amounts,
  ]);
  return { jobId, worker, deliveryHash, proof, allocation, budget };
}

async function settleDynamicIssue({
  label,
  issue,
  funding,
  allocation = parseEther("3"),
  keeperFee = parseEther("1"),
  validatorEntries = dynamicValidatorEntries,
  validatorCatalog = dynamicValidatorCatalog,
  validatorStart = 1,
}) {
  const creator = agents[5];
  const worker = agents[4];
  const planHash = keccak256(toBytes(`${label}-plan`));
  const evidence = evidenceFor(label, issue.specificationHash);
  const recipients = [worker.address];
  const amounts = [allocation];
  const budget = allocation + keeperFee + parseEther("1");
  const terms = [
    {
      worker: worker.address,
      verifier,
      capability,
      specificationHash: issue.specificationHash,
      expectedEvidenceHash: issue.expectedEvidenceHash,
      payoutRoot: payoutRoot(recipients, amounts),
      allocation,
      workerBond: 0n,
      keeperFee,
      deadline: Number(blockTimestamp + 86_400n),
      capacityUnits: 2,
      minimumReveals: issue.minimumReveals,
      passScoreBps: issue.passScoreBps,
      commitWindow: 60,
      revealWindow: 60,
    },
  ];
  const policies = [
    {
      validatorRoot: issue.validatorRoot,
      minimumOperatorGroups: issue.minimumValidatorGroups,
    },
  ];
  const nonce = await read(
    "AgentPoolV432TaskMarket",
    market,
    "nextJobNonce",
  );
  const jobId = jobIdFor(creator.address, nonce, planHash);
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "createSystemJobV2",
    [
      funding,
      budget,
      planHash,
      genesisRelease,
      issue,
      [],
      terms,
      policies,
      [0],
      [[]],
    ],
    creator.key,
  );
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "acceptMilestone",
    [jobId, 0],
    worker.key,
  );
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "deliver",
    [jobId, 0, evidence.deliveryHash],
    worker.key,
  );
  const roundId = keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint32" },
      ],
      ["PROOF", jobId, 0],
    ),
  );
  const validators = validatorEntries.slice(validatorStart, validatorStart + 3);
  const score = 9_500;
  const salts = validators.map((_, index) =>
    keccak256(toBytes(`${label}-validator-salt-${index}`)),
  );
  const evidenceHashes = validators.map((_, index) =>
    keccak256(toBytes(`${label}-validator-evidence-${index}`)),
  );
  for (let index = 0; index < validators.length; index++) {
    const validator = validators[index];
    const commitment = await read(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "commitmentFor",
      [
        roundId,
        validator.address,
        score,
        evidenceHashes[index],
        salts[index],
      ],
    );
    await write(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "commitWithProof",
      [
        roundId,
        commitment,
        validatorCatalog.proofs.get(
          validatorLeaf(validator.address, validator.group),
        ),
      ],
      validator.key,
    );
  }
  blockTimestamp += 61n;
  for (let index = 0; index < validators.length; index++) {
    await write(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "reveal",
      [
        roundId,
        score,
        evidenceHashes[index],
        salts[index],
      ],
      validators[index].key,
    );
  }
  blockTimestamp += 61n;
  await write("AgentPoolV432TaskMarket", market, "resolve", [
    jobId,
    0,
    evidence.proof,
    recipients,
    amounts,
  ]);
  return { jobId, worker, budget, allocation };
}

await expectRevert(
  "only the one-shot BOOTSTRAP proposer may consume a catalog issue",
  () =>
    settleJob({
      funding: 3,
      creatorKey: agents[0].key,
      workerIndex: 1,
      releaseId: genesisRelease,
      allocation: parseEther("1"),
      keeperFee: parseEther("1"),
      capacityUnits: 1,
      label: "bootstrap-improvement",
      issue: bootstrapIssue,
    }),
);
await expectRevert(
  "system proposer cannot replace the admitted evidence policy",
  () =>
    settleJob({
      funding: 3,
      workerIndex: 0,
      releaseId: genesisRelease,
      allocation: parseEther("1"),
      keeperFee: parseEther("1"),
      capacityUnits: 1,
      label: "malicious-evidence-override",
      issue: bootstrapIssue,
    }),
);

const firstSystem = await settleJob({
  funding: 3,
  workerIndex: 0,
  releaseId: genesisRelease,
  allocation: parseEther("100"),
  keeperFee: parseEther("5"),
  capacityUnits: 5,
  label: "bootstrap-improvement",
});
check(
  "system improvement emits only settled amount",
  await read("AgentPoolV43Token", token, "totalSupply"),
  parseEther("105"),
);

const candidateReceiptId = keccak256(toBytes("bootstrap-candidate-attestation"));
const candidateRelease = keccak256(toBytes("agentpool-v4.3-candidate"));
const candidateModuleHash = keccak256(toBytes("candidate-module"));
const candidateManifestHash = keccak256(toBytes("candidate-manifest"));
const canary = {
  qualityBps: 9_300,
  baselineQualityBps: 9_100,
  cost: 900,
  baselineCost: 1_000,
  latency: 1_000,
  baselineLatency: 1_000,
  securityRegressions: 0,
};
await write(
  "AgentPoolV432TaskMarket",
  market,
  "attestCandidate",
  [
    firstSystem.jobId,
    0,
    candidateReceiptId,
    candidateModuleHash,
    candidateManifestHash,
    canary.qualityBps,
    canary.baselineQualityBps,
    canary.cost,
    canary.baselineCost,
    canary.latency,
    canary.baselineLatency,
    canary.securityRegressions,
  ],
  firstSystem.worker.key,
);
await write(
  "AgentPoolV43EvolutionConsensus",
  consensus,
  "proveRelease",
  [
    candidateReceiptId,
    genesisRelease,
    candidateRelease,
    candidateModuleHash,
    candidateManifestHash,
    financeInvariantHash,
    canary,
  ],
  firstSystem.worker.key,
);
check(
  "one BOOTSTRAP AI may prove an opt-in release",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "isUsable", [
    candidateRelease,
  ]),
  true,
);
check(
  "one BOOTSTRAP AI cannot change the recommendation",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "recommendedRelease"),
  genesisRelease,
);

const supplyBeforeExternal = await read(
  "AgentPoolV43Token",
  token,
  "totalSupply",
);
const systemImprovementCapability = keccak256(
  toBytes("agentpool-system-improvement"),
);
const governanceUnitsBeforeExternal = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "totalSuccessfulAt",
  [0, 8],
);
const externalWorkerRuntime = keccak256(toBytes("runtime-1"));
const externalPerformanceBefore = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [
    agents[1].address,
    externalWorkerRuntime,
    systemImprovementCapability,
    0,
    8,
  ],
);
await write(
  "AgentPoolV43CapacityRegistry",
  capacityRegistry,
  "publish",
  [
    systemImprovementCapability,
    64,
    Number(blockTimestamp + 30n * 86_400n),
    keccak256(toBytes("buyer-funded-improvement-runtime")),
  ],
  agents[1].key,
);
const firstExternal = await settleJob({
  funding: 1,
  creatorKey: firstSystem.worker.key,
  workerIndex: 1,
  releaseId: genesisRelease,
  allocation: parseEther("50"),
  keeperFee: parseEther("5"),
  capacityUnits: 10,
  label: "external-buyer-work",
  jobCapability: systemImprovementCapability,
});
check(
  "external buyer work never mints",
  await read("AgentPoolV43Token", token, "totalSupply"),
  supplyBeforeExternal,
);
check(
  "external unused budget is returned",
  await read("AgentPoolV43Token", token, "balanceOf", [
    firstSystem.worker.address,
  ]),
  parseEther("45"),
);
check(
  "external buyer work records performance without creating Work Power",
  (
    await read(
      "AgentPoolV43ContributionLedger",
      ledger,
      "totalSuccessfulAt",
      [0, 8],
    )
  ) === governanceUnitsBeforeExternal,
  true,
);
const externalPerformanceAfter = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [
    agents[1].address,
    externalWorkerRuntime,
    systemImprovementCapability,
    0,
    8,
  ],
);
check(
  "external verified execution still updates the worker capability profile",
  externalPerformanceAfter[0] === externalPerformanceBefore[0] + 10n &&
    externalPerformanceAfter[1] === externalPerformanceBefore[1] + 10n,
  true,
);
await expectRevert(
  "one external milestone cannot inflate performance with unbounded units",
  () =>
    settleJob({
      funding: 1,
      creatorKey: firstSystem.worker.key,
      workerIndex: 1,
      releaseId: genesisRelease,
      allocation: parseEther("1"),
      keeperFee: parseEther("1"),
      capacityUnits: 1_000_001,
      label: "external-capacity-inflation",
      jobCapability: systemImprovementCapability,
    }),
);
const buyerFundedReceipt = keccak256(
  toBytes("buyer-funded-bootstrap-candidate-receipt"),
);
const buyerFundedRelease = keccak256(
  toBytes("buyer-funded-bootstrap-candidate-release"),
);
const buyerFundedModule = keccak256(
  toBytes("buyer-funded-bootstrap-candidate-module"),
);
const buyerFundedManifest = keccak256(
  toBytes("buyer-funded-bootstrap-candidate-manifest"),
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "attestCandidate",
  [
    firstExternal.jobId,
    0,
    buyerFundedReceipt,
    buyerFundedModule,
    buyerFundedManifest,
    canary.qualityBps,
    canary.baselineQualityBps,
    canary.cost,
    canary.baselineCost,
    canary.latency,
    canary.baselineLatency,
    canary.securityRegressions,
  ],
  firstExternal.worker.key,
);
await write(
  "AgentPoolV43EvolutionConsensus",
  consensus,
  "proveRelease",
  [
    buyerFundedReceipt,
    genesisRelease,
    buyerFundedRelease,
    buyerFundedModule,
    buyerFundedManifest,
    financeInvariantHash,
    canary,
  ],
  firstExternal.worker.key,
);
check(
  "buyer-funded improvement can remain opt-in during BOOTSTRAP",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "isUsable", [
    buyerFundedRelease,
  ]),
  true,
);
check(
  "buyer-funded improvement cannot change recommendation",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "recommendedRelease"),
  genesisRelease,
);
check(
  "buyer-funded improvement candidate creates no emission",
  await read("AgentPoolV43Token", token, "totalSupply"),
  supplyBeforeExternal,
);

// If one parallel leaf fails, only that worker may lose its bond. Other
// accepted leaves are cancelled by the project-wide abort, so their bonds and
// capacity must be returned even though they did not settle.
const abortLabel = "external-parallel-abort-bonds";
const abortBuyer = firstExternal.worker;
const abortWorkers = [firstSystem.worker, agents[4]];
const abortBond = parseEther("2");
const abortAllocation = parseEther("2");
const abortKeeperFee = parseEther("1");
const abortBudget = parseEther("7");
const abortPlanHash = keccak256(toBytes(`${abortLabel}-plan`));
const abortEvidence = abortWorkers.map((_, index) => {
  const specificationHash = keccak256(
    toBytes(`${abortLabel}-specification-${index}`),
  );
  return {
    specificationHash,
    ...evidenceFor(`${abortLabel}-${index}`, specificationHash),
  };
});
const abortTerms = abortWorkers.map((worker, index) => ({
  worker: worker.address,
  verifier,
  capability,
  specificationHash: abortEvidence[index].specificationHash,
  expectedEvidenceHash: abortEvidence[index].expectedEvidenceHash,
  payoutRoot: payoutRoot([worker.address], [abortAllocation]),
  allocation: abortAllocation,
  workerBond: abortBond,
  keeperFee: abortKeeperFee,
  deadline: Number(blockTimestamp + BigInt((index + 1) * 86_400)),
  capacityUnits: 2,
  minimumReveals: 0,
  passScoreBps: 0,
  commitWindow: 0,
  revealWindow: 0,
}));
const abortPolicies = abortTerms.map(() => ({
  validatorRoot: `0x${"00".repeat(32)}`,
  minimumOperatorGroups: 0,
}));
const abortNonce = await read(
  "AgentPoolV432TaskMarket",
  market,
  "nextJobNonce",
);
const abortJobId = jobIdFor(
  abortBuyer.address,
  abortNonce,
  abortPlanHash,
);
await write(
  "AgentPoolV43Token",
  token,
  "transfer",
  [abortWorkers[1].address, abortBond],
  abortBuyer.key,
);
for (const worker of abortWorkers) {
  await write(
    "AgentPoolV43Token",
    token,
    "approve",
    [market, abortBond],
    worker.key,
  );
}
const abortBuyerBefore = await read(
  "AgentPoolV43Token",
  token,
  "balanceOf",
  [abortBuyer.address],
);
const failedWorkerBefore = await read(
  "AgentPoolV43Token",
  token,
  "balanceOf",
  [abortWorkers[0].address],
);
const innocentWorkerBefore = await read(
  "AgentPoolV43Token",
  token,
  "balanceOf",
  [abortWorkers[1].address],
);
const supplyBeforeAbort = await read(
  "AgentPoolV43Token",
  token,
  "totalSupply",
);
await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [userEscrow, abortBudget],
  abortBuyer.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "createExternalJobV2",
  [
    abortBudget,
    abortPlanHash,
    genesisRelease,
    abortTerms,
    abortPolicies,
    [0, 0],
  ],
  abortBuyer.key,
);
for (let milestoneIndex = 0; milestoneIndex < abortWorkers.length; milestoneIndex++) {
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "acceptMilestone",
    [abortJobId, milestoneIndex],
    abortWorkers[milestoneIndex].key,
  );
}
await write(
  "AgentPoolV432TaskMarket",
  market,
  "deliver",
  [abortJobId, 0, abortEvidence[0].deliveryHash],
  abortWorkers[0].key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "resolve",
  [
    abortJobId,
    0,
    toHex("invalid-parallel-delivery-proof"),
    [abortWorkers[0].address],
    [abortAllocation],
  ],
);
const abortedJob = await read(
  "AgentPoolV432TaskMarket",
  market,
  "jobs",
  [abortJobId],
);
const failedMilestone = await read(
  "AgentPoolV432TaskMarket",
  market,
  "milestones",
  [abortJobId, 0],
);
const innocentMilestone = await read(
  "AgentPoolV432TaskMarket",
  market,
  "milestones",
  [abortJobId, 1],
);
check("failed parallel job is rejected", abortedJob[2], 5);
check("failed parallel leaf is rejected", failedMilestone[16], 5);
check("innocent parallel leaf is refunded", innocentMilestone[16], 6);
check(
  "failed parallel worker alone loses its bond",
  await read("AgentPoolV43Token", token, "balanceOf", [
    abortWorkers[0].address,
  ]),
  failedWorkerBefore - abortBond,
);
check(
  "innocent parallel worker recovers its full bond",
  await read("AgentPoolV43Token", token, "balanceOf", [
    abortWorkers[1].address,
  ]),
  innocentWorkerBefore,
);
check(
  "external buyer recovers budget and receives only failed bond",
  await read("AgentPoolV43Token", token, "balanceOf", [
    abortBuyer.address,
  ]),
  abortBuyerBefore + abortBond,
);
for (const worker of abortWorkers) {
  const offer = await read(
    "AgentPoolV43CapacityRegistry",
    capacityRegistry,
    "offers",
    [worker.address, capability],
  );
  check(
    `parallel abort releases ${worker.address} capacity`,
    offer[1],
    0,
  );
}
check(
  "parallel abort never mints",
  await read("AgentPoolV43Token", token, "totalSupply"),
  supplyBeforeAbort,
);

// A worker cannot validate its own milestone, and the job cannot settle until
// three explicitly allowlisted, independently registered operator groups have
// committed and revealed evidence.
const panelWorker = agents[4];
const panelValidators = agents.slice(1, 4).map((agent, index) => ({
  ...agent,
  group: keccak256(toBytes(`operator-group-${index + 1}`)),
}));
const excludedPanelEntry = {
  ...panelWorker,
  group: keccak256(toBytes("operator-group-0")),
};
const panelEntries = [...panelValidators, excludedPanelEntry];
const panelCatalog = merkleFromLeaves(
  panelEntries.map((entry) => validatorLeaf(entry.address, entry.group)),
);
const panelLabel = "external-independent-panel";
const panelSpecificationHash = keccak256(
  toBytes(`${panelLabel}-specification`),
);
const panelEvidence = evidenceFor(panelLabel, panelSpecificationHash);
const panelRecipients = [panelWorker.address];
const panelAmounts = [parseEther("10")];
const panelBudget = parseEther("12");
const panelPlanHash = keccak256(toBytes(`${panelLabel}-plan`));
const panelNonce = await read(
  "AgentPoolV432TaskMarket",
  market,
  "nextJobNonce",
);
const panelJobId = jobIdFor(
  firstSystem.worker.address,
  panelNonce,
  panelPlanHash,
);
const panelTerms = [
  {
    worker: panelWorker.address,
    verifier,
    capability,
    specificationHash: panelSpecificationHash,
    expectedEvidenceHash: panelEvidence.expectedEvidenceHash,
    payoutRoot: payoutRoot(panelRecipients, panelAmounts),
    allocation: panelAmounts[0],
    workerBond: 0n,
    keeperFee: parseEther("1"),
    deadline: Number(blockTimestamp + 86_400n),
    capacityUnits: 2,
    minimumReveals: 3,
    passScoreBps: 9_000,
    commitWindow: 60,
    revealWindow: 60,
  },
];
const panelPolicies = [
  {
    validatorRoot: panelCatalog.root,
    minimumOperatorGroups: 3,
  },
];
await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [userEscrow, panelBudget],
  firstSystem.worker.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "createExternalJobV2",
  [
    panelBudget,
    panelPlanHash,
    genesisRelease,
    panelTerms,
    panelPolicies,
    [0],
  ],
  firstSystem.worker.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "acceptMilestone",
  [panelJobId, 0],
  panelWorker.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "deliver",
  [panelJobId, 0, panelEvidence.deliveryHash],
  panelWorker.key,
);
const panelRoundId = keccak256(
  encodeAbiParameters(
    [
      { type: "string" },
      { type: "bytes32" },
      { type: "uint32" },
    ],
    ["PROOF", panelJobId, 0],
  ),
);
const panelScore = 9_500;
const panelSalts = panelValidators.map((_, index) =>
  keccak256(toBytes(`panel-salt-${index}`)),
);
const panelEvidenceHashes = panelValidators.map((_, index) =>
  keccak256(toBytes(`panel-evidence-${index}`)),
);
const excludedSalt = keccak256(toBytes("excluded-panel-salt"));
const excludedEvidenceHash = keccak256(
  toBytes("excluded-panel-evidence"),
);
const excludedCommitment = await read(
  "AgentPoolV432ProofRegistry",
  proofRegistry,
  "commitmentFor",
  [
    panelRoundId,
    excludedPanelEntry.address,
    panelScore,
    excludedEvidenceHash,
    excludedSalt,
  ],
);
await expectRevert(
  "worker operator group is excluded from its validator panel",
  () =>
    write(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "commitWithProof",
      [
        panelRoundId,
        excludedCommitment,
        panelCatalog.proofs.get(
          validatorLeaf(
            excludedPanelEntry.address,
            excludedPanelEntry.group,
          ),
        ),
      ],
      excludedPanelEntry.key,
    ),
);
for (let index = 0; index < panelValidators.length; index++) {
  const validator = panelValidators[index];
  const commitment = await read(
    "AgentPoolV432ProofRegistry",
    proofRegistry,
    "commitmentFor",
    [
      panelRoundId,
      validator.address,
      panelScore,
      panelEvidenceHashes[index],
      panelSalts[index],
    ],
  );
  await write(
    "AgentPoolV432ProofRegistry",
    proofRegistry,
    "commitWithProof",
    [
      panelRoundId,
      commitment,
      panelCatalog.proofs.get(
        validatorLeaf(validator.address, validator.group),
      ),
    ],
    validator.key,
  );
}
blockTimestamp += 61n;
for (let index = 0; index < panelValidators.length; index++) {
  await write(
    "AgentPoolV432ProofRegistry",
    proofRegistry,
    "reveal",
    [
      panelRoundId,
      panelScore,
      panelEvidenceHashes[index],
      panelSalts[index],
    ],
    panelValidators[index].key,
  );
}
blockTimestamp += 61n;
const supplyBeforePanel = await read(
  "AgentPoolV43Token",
  token,
  "totalSupply",
);
await write("AgentPoolV432TaskMarket", market, "resolve", [
  panelJobId,
  0,
  panelEvidence.proof,
  panelRecipients,
  panelAmounts,
]);
check(
  "external validator panel represents three operator groups",
  await read(
    "AgentPoolV432ProofRegistry",
    proofRegistry,
    "groupCount",
    [panelRoundId],
  ),
  3,
);
check(
  "validated external panel work still never mints",
  await read("AgentPoolV43Token", token, "totalSupply"),
  supplyBeforePanel,
);

// Two independent DAG leaves may run at the same time. A dependent leaf
// remains locked until both are settled, and only the unfinished leaf may be
// replaced after a budget hold.
const dagLabel = "external-parallel-dag";
const dagPlanHash = keccak256(toBytes(`${dagLabel}-plan`));
const dagWorkers = [agents[1], agents[2], agents[3]];
const dagEvidence = dagWorkers.map((_, index) => {
  const specificationHash = keccak256(
    toBytes(`${dagLabel}-specification-${index}`),
  );
  return {
    specificationHash,
    ...evidenceFor(`${dagLabel}-${index}`, specificationHash),
  };
});
const dagTerms = dagWorkers.map((worker, index) => ({
  worker: worker.address,
  verifier,
  capability,
  specificationHash: dagEvidence[index].specificationHash,
  expectedEvidenceHash: dagEvidence[index].expectedEvidenceHash,
  payoutRoot: payoutRoot([worker.address], [parseEther("2")]),
  allocation: parseEther("2"),
  workerBond: 0n,
  keeperFee: parseEther("1"),
  deadline: Number(blockTimestamp + BigInt((index + 1) * 3_600)),
  capacityUnits: 2,
  minimumReveals: 0,
  passScoreBps: 0,
  commitWindow: 0,
  revealWindow: 0,
}));
const dagPolicies = dagTerms.map(() => ({
  validatorRoot: `0x${"00".repeat(32)}`,
  minimumOperatorGroups: 0,
}));
const dagDependencies = [0, 0, 3];
const dagBudget = parseEther("10");
const dagNonce = await read(
  "AgentPoolV432TaskMarket",
  market,
  "nextJobNonce",
);
const dagJobId = jobIdFor(
  firstSystem.worker.address,
  dagNonce,
  dagPlanHash,
);
await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [userEscrow, dagBudget],
  firstSystem.worker.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "createExternalJobV2",
  [
    dagBudget,
    dagPlanHash,
    genesisRelease,
    dagTerms,
    dagPolicies,
    dagDependencies,
  ],
  firstSystem.worker.key,
);
for (const milestoneIndex of [0, 1]) {
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "acceptMilestone",
    [dagJobId, milestoneIndex],
    dagWorkers[milestoneIndex].key,
  );
}
check(
  "independent DAG leaves reserve capacity in parallel",
  await read(
    "AgentPoolV432TaskMarket",
    market,
    "activeMilestones",
    [dagJobId],
  ),
  2,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "deliver",
  [dagJobId, 1, dagEvidence[1].deliveryHash],
  dagWorkers[1].key,
);
await write("AgentPoolV432TaskMarket", market, "resolve", [
  dagJobId,
  1,
  dagEvidence[1].proof,
  [dagWorkers[1].address],
  [parseEther("2")],
]);
check(
  "out-of-order independent leaf settles without closing the DAG",
  await read(
    "AgentPoolV432TaskMarket",
    market,
    "settledMasks",
    [dagJobId],
  ),
  2,
);
await expectRevert(
  "dependent DAG leaf cannot start before every dependency settles",
  () =>
    write(
      "AgentPoolV432TaskMarket",
      market,
      "acceptMilestone",
      [dagJobId, 2],
      dagWorkers[2].key,
    ),
);
await expectRevert(
  "active work cannot be silently replaced by a replan",
  () =>
    write(
      "AgentPoolV432TaskMarket",
      market,
      "holdBudget",
      [dagJobId, keccak256(toBytes("premature-replan"))],
      firstSystem.worker.key,
    ),
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "deliver",
  [dagJobId, 0, dagEvidence[0].deliveryHash],
  dagWorkers[0].key,
);
await write("AgentPoolV432TaskMarket", market, "resolve", [
  dagJobId,
  0,
  dagEvidence[0].proof,
  [dagWorkers[0].address],
  [parseEther("2")],
]);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "holdBudget",
  [dagJobId, keccak256(toBytes("replace-unfinished-leaf"))],
  firstSystem.worker.key,
);
const replacementWorker = agents[4];
const replacementSpecificationHash = keccak256(
  toBytes(`${dagLabel}-replacement-specification`),
);
const replacementEvidence = evidenceFor(
  `${dagLabel}-replacement`,
  replacementSpecificationHash,
);
const replannedTerms = [
  dagTerms[0],
  dagTerms[1],
  {
    ...dagTerms[2],
    worker: replacementWorker.address,
    specificationHash: replacementSpecificationHash,
    expectedEvidenceHash: replacementEvidence.expectedEvidenceHash,
    payoutRoot: payoutRoot(
      [replacementWorker.address],
      [parseEther("1")],
    ),
    allocation: parseEther("1"),
    deadline: Number(blockTimestamp + 14_400n),
  },
];
const replacementPlanHash = keccak256(
  toBytes(`${dagLabel}-replacement-plan`),
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "replanRemainingV2",
  [
    dagJobId,
    replacementPlanHash,
    replannedTerms,
    dagPolicies,
    dagDependencies,
    [],
  ],
  firstSystem.worker.key,
);
check(
  "partial replan preserves the two completed leaves",
  await read(
    "AgentPoolV432TaskMarket",
    market,
    "settledMasks",
    [dagJobId],
  ),
  3,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "acceptMilestone",
  [dagJobId, 2],
  replacementWorker.key,
);
await write(
  "AgentPoolV432TaskMarket",
  market,
  "deliver",
  [dagJobId, 2, replacementEvidence.deliveryHash],
  replacementWorker.key,
);
await write("AgentPoolV432TaskMarket", market, "resolve", [
  dagJobId,
  2,
  replacementEvidence.proof,
  [replacementWorker.address],
  [parseEther("1")],
]);
const dagJob = await read(
  "AgentPoolV432TaskMarket",
  market,
  "jobs",
  [dagJobId],
);
check(
  "parallel DAG closes only after the replanned dependent leaf settles",
  dagJob[2],
  4,
);

await expectRevert("CORE emission is unavailable during BOOTSTRAP", () =>
  write("AgentPoolV432TaskMarket", market, "createSystemJobV2", [
    2,
    parseEther("2"),
    keccak256(toBytes("forbidden-core-plan")),
    genesisRelease,
    issueFor("forbidden-core", 2),
    [],
    [],
    [],
    [],
    [],
  ]),
);

// Accumulate real TaskMarket receipts over two epochs. No direct ledger writes
// or fabricated maturity switches are used.
for (let index = 0; index < 23; index++) {
  await settleJob({
    funding: 3,
    workerIndex: index % 5,
    releaseId: genesisRelease,
    allocation: parseEther("1"),
    keeperFee: parseEther("1"),
    capacityUnits: 1,
    label: `epoch-zero-${index}`,
  });
}
const originalRuntimeHash = keccak256(toBytes("runtime-0"));
const originalRuntimePerformance = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimePerformanceAt",
  [agents[0].address, originalRuntimeHash, 0, 8],
);
const originalCapabilityPerformance = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [agents[0].address, originalRuntimeHash, capability, 0, 8],
);
const unrelatedCapabilityPerformance = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [
    agents[0].address,
    originalRuntimeHash,
    keccak256(toBytes("unrelated-capability")),
    0,
    8,
  ],
);
check(
  "verified work accrues only to the active runtime and capability",
  originalRuntimePerformance[0] > 0n &&
    originalRuntimePerformance[1] > 0n &&
    originalCapabilityPerformance[0] > 0n &&
    originalCapabilityPerformance[1] > 0n &&
    unrelatedCapabilityPerformance[0] === 0n &&
    unrelatedCapabilityPerformance[1] === 0n,
  true,
);
const replacementRuntimeHash = keccak256(
  toBytes("runtime-0-replacement"),
);
await write(
  "AgentPoolV43ContributionLedger",
  ledger,
  "updateRuntime",
  [replacementRuntimeHash],
  agents[0].key,
);
const replacementRuntimeBeforeWork = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [agents[0].address, replacementRuntimeHash, capability, 0, 8],
);
check(
  "a replacement runtime cannot inherit prior model performance",
  replacementRuntimeBeforeWork[0] === 0n &&
    replacementRuntimeBeforeWork[1] === 0n,
  true,
);
blockTimestamp += 7n * 86_400n + 1n;
await settleJob({
  funding: 3,
  workerIndex: 0,
  releaseId: genesisRelease,
  allocation: parseEther("1"),
  keeperFee: parseEther("1"),
  capacityUnits: 1,
  label: "epoch-one-0",
});
const replacementRuntimeAfterWork = await read(
  "AgentPoolV43ContributionLedger",
  ledger,
  "runtimeCapabilityPerformanceAt",
  [agents[0].address, replacementRuntimeHash, capability, 1, 8],
);
check(
  "replacement runtime starts earning performance from its own result",
  replacementRuntimeAfterWork[0] === 1n &&
    replacementRuntimeAfterWork[1] === 1n,
  true,
);
check(
  "two active epochs and real work open limited TRANSITION",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "transitionReady",
  ),
  true,
);
check(
  "TRANSITION opens before irreversible MATURE",
  await read("AgentPoolV43ContributionLedger", ledger, "mature"),
  false,
);

const transitionIssue = dynamicIssueFor(
  "transition-dynamic-improvement",
  3,
);
const transitionNeedEvidence = keccak256(
  toBytes("transition-dynamic-improvement-need-evidence"),
);
await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [transitionIssueConsensus, proposalBond],
  agents[0].key,
);
const transitionCommitDeadline = Number(blockTimestamp + 86_500n);
const transitionRevealDeadline = transitionCommitDeadline + 86_500;
const unsafeTransitionIssue = {
  ...dynamicIssueFor("unsafe-transition-budget", 3),
  candidateBudgetCap: parseEther("11"),
};
const unsafeTransitionValidatorIssue = dynamicIssueFor(
  "unsafe-transition-validator-set",
  3,
  evolvedValidatorCatalog,
);
const proposerBalanceBeforeUnsafeIssue = await read(
  "AgentPoolV43Token",
  token,
  "balanceOf",
  [agents[0].address],
);
await expectRevert(
  "unsafe TRANSITION Issue is rejected before its bond can be locked",
  () =>
    write(
      "AgentPoolV435TransitionIssueConsensus",
      transitionIssueConsensus,
      "propose",
      [
        unsafeTransitionIssue,
        keccak256(toBytes("unsafe-transition-evidence")),
        proposalBond,
        transitionCommitDeadline,
        transitionRevealDeadline,
      ],
      agents[0].key,
    ),
);
await expectRevert(
  "TRANSITION cannot replace the deployment validator set",
  () =>
    write(
      "AgentPoolV435TransitionIssueConsensus",
      transitionIssueConsensus,
      "propose",
      [
        unsafeTransitionValidatorIssue,
        keccak256(toBytes("unsafe-transition-validator-evidence")),
        proposalBond,
        transitionCommitDeadline,
        transitionRevealDeadline,
      ],
      agents[0].key,
    ),
);
check(
  "rejected unsafe TRANSITION Issue leaves proposer funds untouched",
  await read("AgentPoolV43Token", token, "balanceOf", [
    agents[0].address,
  ]),
  proposerBalanceBeforeUnsafeIssue,
);
await write(
  "AgentPoolV435TransitionIssueConsensus",
  transitionIssueConsensus,
  "propose",
  [
    transitionIssue,
    transitionNeedEvidence,
    proposalBond,
    transitionCommitDeadline,
    transitionRevealDeadline,
  ],
  agents[0].key,
);
const transitionVoters = agents.slice(1, 3);
const transitionSalts = transitionVoters.map((_, index) =>
  keccak256(toBytes(`transition-issue-vote-${index}`)),
);
const transitionEvidenceHashes = transitionVoters.map((_, index) =>
  keccak256(toBytes(`transition-issue-evidence-${index}`)),
);
const proposerCommitment = await read(
  "AgentPoolV435TransitionIssueConsensus",
  transitionIssueConsensus,
  "voteCommitment",
  [
    1n,
    agents[0].address,
    true,
    transitionNeedEvidence,
    keccak256(toBytes("proposer-self-vote")),
  ],
);
await expectRevert(
  "TRANSITION proposer cannot validate its own dynamic Issue",
  () =>
    write(
      "AgentPoolV435TransitionIssueConsensus",
      transitionIssueConsensus,
      "commitVote",
      [1n, proposerCommitment],
      agents[0].key,
    ),
);
for (let index = 0; index < transitionVoters.length; index++) {
  const voter = transitionVoters[index];
  const commitment = await read(
    "AgentPoolV435TransitionIssueConsensus",
    transitionIssueConsensus,
    "voteCommitment",
    [
      1n,
      voter.address,
      true,
      transitionEvidenceHashes[index],
      transitionSalts[index],
    ],
  );
  await write(
    "AgentPoolV435TransitionIssueConsensus",
    transitionIssueConsensus,
    "commitVote",
    [1n, commitment],
    voter.key,
  );
}
blockTimestamp = BigInt(transitionCommitDeadline + 1);
for (let index = 0; index < transitionVoters.length; index++) {
  await write(
    "AgentPoolV435TransitionIssueConsensus",
    transitionIssueConsensus,
    "revealVote",
    [
      1n,
      true,
      transitionEvidenceHashes[index],
      transitionSalts[index],
    ],
    transitionVoters[index].key,
  );
}
blockTimestamp = BigInt(transitionRevealDeadline + 1);
await write(
  "AgentPoolV435TransitionIssueConsensus",
  transitionIssueConsensus,
  "finalize",
  [1n],
);
check(
  "two non-proposer voters across multiple groups approve capped TRANSITION Issue",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "transitionApprovedIssueHash",
    [issueTermsHash(transitionIssue)],
  ),
  true,
);
const supplyBeforeTransitionIssue = await read(
  "AgentPoolV43Token",
  token,
  "totalSupply",
);
await settleDynamicIssue({
  label: "transition-dynamic-improvement",
  issue: transitionIssue,
  funding: 3,
});
check(
  "TRANSITION dynamic Issue emits only objective settled payouts",
  await read("AgentPoolV43Token", token, "totalSupply"),
  supplyBeforeTransitionIssue + parseEther("4"),
);

for (let index = 1; index < 25; index++) {
  await settleJob({
    funding: 3,
    workerIndex: index % 5,
    releaseId: genesisRelease,
    allocation: parseEther("1"),
    keeperFee: parseEther("1"),
    capacityUnits: 1,
    label: `epoch-one-${index}`,
  });
}

check(
  "two-epoch verified activity irreversibly reaches MATURE",
  await read("AgentPoolV43ContributionLedger", ledger, "mature"),
  true,
);
check(
  "maturity used at least fifty successful settlements",
  (
    await read(
      "AgentPoolV43ContributionLedger",
      ledger,
      "successfulSettlementCount",
    )
  ) >= 50n,
  true,
);

const matureIssue = dynamicIssueFor(
  "mature-core-approved-issue",
  2,
  evolvedValidatorCatalog,
);
check(
  "MATURE Issue may propose a validator root distinct from deployment",
  matureIssue.validatorRoot !== dynamicValidatorCatalog.root,
  true,
);
await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [issueConsensus, proposalBond],
  agents[0].key,
);
const issueCommitDeadline = Number(blockTimestamp + 86_500n);
const issueRevealDeadline = issueCommitDeadline + 86_500;
await write(
  "AgentPoolV432IssueConsensus",
  issueConsensus,
  "propose",
  [
    matureIssue,
    proposalBond,
    issueCommitDeadline,
    issueRevealDeadline,
  ],
  agents[0].key,
);
const issueSalts = agents.slice(0, 5).map((_, index) =>
  keccak256(toBytes(`mature-issue-vote-${index}`)),
);
for (let index = 0; index < 5; index++) {
  const commitment = await read(
    "AgentPoolV432IssueConsensus",
    issueConsensus,
    "voteCommitment",
    [1n, agents[index].address, true, issueSalts[index]],
  );
  await write(
    "AgentPoolV432IssueConsensus",
    issueConsensus,
    "commitVote",
    [1n, commitment],
    agents[index].key,
  );
}
blockTimestamp = BigInt(issueCommitDeadline + 1);
for (let index = 0; index < 5; index++) {
  await write(
    "AgentPoolV432IssueConsensus",
    issueConsensus,
    "revealVote",
    [1n, true, issueSalts[index]],
    agents[index].key,
  );
}
blockTimestamp = BigInt(issueRevealDeadline + 1);
await write(
  "AgentPoolV432IssueConsensus",
  issueConsensus,
  "finalize",
  [1n],
);
check(
  "MATURE new system issue requires and receives Work Power consensus",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "approvedIssueHash",
    [issueTermsHash(matureIssue)],
  ),
  true,
);
const matureSettlement = await settleDynamicIssue({
  label: "mature-core-approved-issue",
  issue: matureIssue,
  funding: 2,
  validatorEntries: evolvedValidatorEntries,
  validatorCatalog: evolvedValidatorCatalog,
  validatorStart: 0,
});
const matureProofRound = keccak256(
  encodeAbiParameters(
    [
      { type: "string" },
      { type: "bytes32" },
      { type: "uint32" },
    ],
    ["PROOF", matureSettlement.jobId, 0],
  ),
);
check(
  "MATURE approved validator set verifies work across three groups",
  await read("AgentPoolV432ProofRegistry", proofRegistry, "groupCount", [
    matureProofRound,
  ]),
  3,
);

await write(
  "AgentPoolV43Token",
  token,
  "approve",
  [consensus, proposalBond],
  agents[0].key,
);
const commitDeadline = Number(blockTimestamp + 86_500n);
const revealDeadline = commitDeadline + 86_500;
const adoptionDeadline = revealDeadline + 10 * 86_400;
await write(
  "AgentPoolV43EvolutionConsensus",
  consensus,
  "proposeRecommendation",
  [
    candidateRelease,
    "0x0000000000000000000000000000000000000000",
    false,
    proposalBond,
    commitDeadline,
    revealDeadline,
    adoptionDeadline,
  ],
  agents[0].key,
);

const salts = agents.slice(0, 5).map((_, index) =>
  keccak256(toBytes(`mature-vote-${index}`)),
);
for (let index = 0; index < 5; index++) {
  const commitment = await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "voteCommitment",
    [1n, agents[index].address, true, salts[index]],
  );
  await write(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "commitVote",
    [1n, commitment],
    agents[index].key,
  );
}
check(
  "MATURE vote alone still cannot change recommendation",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "recommendedRelease"),
  genesisRelease,
);
blockTimestamp = BigInt(commitDeadline + 1);
for (let index = 0; index < 5; index++) {
  await write(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "revealVote",
    [1n, true, salts[index]],
    agents[index].key,
  );
}
blockTimestamp = BigInt(revealDeadline + 1);
await write("AgentPoolV43EvolutionConsensus", consensus, "finalizeVote", [1n]);
check(
  "vote makes the release await independent adoption",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "recommendedRelease"),
  genesisRelease,
);

for (let index = 0; index < 5; index++) {
  const adoptionJob = await settleJob({
    funding: 3,
    workerIndex: index,
    releaseId: candidateRelease,
    allocation: parseEther("1"),
    keeperFee: parseEther("1"),
    capacityUnits: 1,
    label: `candidate-adoption-${index}`,
  });
  await write(
    "AgentPoolV432TaskMarket",
    market,
    "recordReleaseAdoption",
    [
      adoptionJob.jobId,
      0,
      1n,
      keccak256(toBytes(`candidate-adoption-receipt-${index}`)),
    ],
    adoptionJob.worker.key,
  );
}
check(
  "vote plus three-group adoption recommends the release",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "recommendedRelease"),
  candidateRelease,
);
check(
  "genesis release remains usable after recommendation changes",
  await read("AgentPoolV43ReleaseRegistry", releaseRegistry, "isUsable", [
    genesisRelease,
  ]),
  true,
);
await expectRevert("bootstrap issue candidate count is finite", () =>
  settleJob({
    funding: 3,
    workerIndex: 0,
    releaseId: genesisRelease,
    allocation: parseEther("1"),
    keeperFee: parseEther("1"),
    capacityUnits: 1,
    label: "bootstrap-candidate-overflow",
  }),
);

const output = {
  schemaVersion: 1,
  network: "in-memory-cancun",
  chainId: 31337,
  phase: "MATURE_REHEARSAL",
  tokenArtifactName,
  contracts: {
    token,
    userEscrow,
    coreVault,
    evolutionVault,
    contributionLedger: ledger,
    evolutionConsensus: consensus,
    systemIssueGate,
    transitionIssueConsensus,
    issueConsensus,
    releaseRegistry,
    taskMarket: market,
    capacityRegistry,
    proofRegistry,
    settlementRouter,
    verifier,
  },
  financeInvariantHash,
  genesisRelease,
  candidateRelease,
  transactionCount,
  gasSpent: gasSpent.toString(),
  checks,
  passed: checks.every((entry) => entry.passed),
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", rehearsalOutputName),
  `${JSON.stringify(output, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(output)}\n`);
