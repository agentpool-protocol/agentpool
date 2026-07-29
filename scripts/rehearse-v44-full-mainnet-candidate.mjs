import fs from "node:fs";
import path from "node:path";
import { createBlock } from "@ethereumjs/block";
import {
  Common,
  Hardfork,
  Mainnet,
  createCustomCommon,
} from "@ethereumjs/common";
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
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";
import {
  ROOT,
  ZERO_ADDRESS,
  artifact,
  buildBootstrapTerms,
  loadAndValidateConfig,
} from "./lib/v44-mainnet.mjs";

const configEvidence = loadAndValidateConfig();
const { config, financeInvariantHash } = configEvidence;
const common = createCustomCommon(
  {
    chainId: 8453,
    name: "AgentPool v4.4 Exact Mainnet Graph Rehearsal",
  },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) {
  throw new Error("V44_FULL_REHEARSAL_COMMON_FAILED");
}
const vm = await createVM({ common, activatePrecompiles: true });

function keyFor(index) {
  return hexToBytes(
    `0x${BigInt(index).toString(16).padStart(64, "0")}`,
  );
}

function addressFor(key) {
  return getAddress(createAddressFromPrivateKey(key).toString());
}

const deployerKey = keyFor(201);
const workerKey = keyFor(202);
const validatorKeys = [203, 204, 205].map(keyFor);
const initiallyUnregisteredKey = keyFor(206);
const deployer = addressFor(deployerKey);
const worker = addressFor(workerKey);
const initiallyUnregisteredWorker = addressFor(initiallyUnregisteredKey);
const validators = validatorKeys.map((key, index) => ({
  key,
  address: addressFor(key),
  group: keccak256(toBytes(`v44-validator-group-${index}`)),
}));
const workerGroup = keccak256(toBytes("v44-worker-group"));
const proposerGroup = keccak256(toBytes("v44-proposer-group"));
const workerRuntime = keccak256(toBytes("v44-worker-runtime"));
const validatorRuntime = validators.map((_, index) =>
  keccak256(toBytes(`v44-validator-runtime-${index}`)),
);
for (const key of [
  deployerKey,
  workerKey,
  ...validatorKeys,
  initiallyUnregisteredKey,
]) {
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(key),
    createAccount({ nonce: 0n, balance: parseEther("100") }),
  );
}

let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1_000));
let transactionCount = 0;
let gasSpent = 0n;
const checks = [];

function normalized(value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function check(name, actual, expected) {
  const passed =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: normalized(actual),
    expected: normalized(expected),
  });
  if (!passed) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
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
      `V44_FULL_LOCAL_EVM_REVERT:${result.execResult.exceptionError.error}:${bytesToHex(result.execResult.returnValue)}`,
    );
  }
  return result;
}

async function deploy(name, args = []) {
  const compiled = artifact(name);
  const result = await execute(
    encodeDeployData({
      abi: compiled.abi,
      bytecode: compiled.bytecode,
      args,
    }),
  );
  if (!result.createdAddress) {
    throw new Error(`V44_FULL_DEPLOYMENT_FAILED:${name}`);
  }
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0 || code.length > 24_576) {
    throw new Error(`V44_FULL_CODE_SIZE_INVALID:${name}:${code.length}`);
  }
  return getAddress(result.createdAddress.toString());
}

async function write(name, address, functionName, args = [], key = deployerKey) {
  return execute(
    encodeFunctionData({
      abi: artifact(name).abi,
      functionName,
      args,
    }),
    address,
    key,
  );
}

async function read(name, address, functionName, args = []) {
  const data = encodeFunctionData({
    abi: artifact(name).abi,
    functionName,
    args,
  });
  const result = await vm.evm.runCall({
    to: createAddressFromString(address),
    caller: createAddressFromString(deployer),
    origin: createAddressFromString(deployer),
    data: hexToBytes(data),
    gasLimit: 30_000_000n,
  });
  if (result.execResult.exceptionError) {
    throw new Error(
      `V44_FULL_LOCAL_CALL_REVERT:${functionName}:${result.execResult.exceptionError.error}`,
    );
  }
  return decodeFunctionResult({
    abi: artifact(name).abi,
    functionName,
    data: bytesToHex(result.execResult.returnValue),
  });
}

async function expectRevert(name, operation) {
  try {
    await operation();
  } catch {
    checks.push({
      name,
      passed: true,
      actual: "reverted",
      expected: "reverted",
    });
    return;
  }
  throw new Error(`${name}: expected revert`);
}

function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}

function jobIdFor(market, creator, nonce, planHash) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [8453n, market, creator, nonce, planHash],
    ),
  );
}

function proofRoundId(jobId, milestoneIndex) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
      ["PROOF", jobId, milestoneIndex],
    ),
  );
}

function deterministicEvidence(label) {
  const specificationHash = keccak256(toBytes(`${label}-specification`));
  const deliveryHash = keccak256(toBytes(`${label}-delivery`));
  const proof = toHex(`${label}-proof`);
  return {
    specificationHash,
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

const genesisStart = Number(blockTimestamp + 300n);
const sourceCommit = "44".repeat(20);
const genesisModuleHash = keccak256(toBytes("v44-exact-genesis-module"));
const genesisManifestHash = keccak256(
  toBytes("v44-exact-genesis-manifest"),
);
const genesisRelease = keccak256(
  encodeAbiParameters(
    [{ type: "bytes20" }, { type: "bytes32" }, { type: "bytes32" }],
    [`0x${sourceCommit}`, genesisModuleHash, genesisManifestHash],
  ),
);
const bootstrapObjectives = Array.from(
  { length: config.bootstrap.minimumObjectives },
  (_, index) => {
    const proof = toHex(`v44-objective-proof-${index}`);
    return {
      capabilityHash: keccak256(toBytes("v44-system-improvement")),
      specificationHash: keccak256(
        toBytes(`v44-objective-specification-${index}`),
      ),
      deliveryHash: keccak256(
        toBytes(`v44-objective-delivery-${index}`),
      ),
      objectiveProof: proof,
      capacityUnits: config.bootstrap.capacityUnits,
    };
  },
);
const releaseInputs = {
  sourceCommit,
  genesisStart,
  genesisRelease,
  genesisModuleHash,
  genesisManifestHash,
  bootstrap: {
    proposer: deployer,
    validators: validators.map(({ address, group }) => ({
      address,
      group,
    })),
    issueId: keccak256(toBytes("v44-exact-bootstrap-issue")),
    objectives: bootstrapObjectives,
    objectivesSha256: "ab".repeat(32),
  },
};

const proposalBond = parseEther(config.consensus.proposalBondApool);
const dynamicCandidateBond = parseEther(
  config.dynamicIssues.candidateAdmissionBondApool,
);
const token = await deploy("AgentPoolV44Token", [deployer]);
const settlementRouter = await deploy(
  "AgentPoolV43SettlementRouter",
  [deployer],
);
const releaseRegistry = await deploy("AgentPoolV43ReleaseRegistry", [
  genesisRelease,
  genesisModuleHash,
  genesisManifestHash,
  deployer,
]);
const capacityRegistry = await deploy(
  "AgentPoolV43CapacityRegistry",
  [deployer],
);
const userEscrow = await deploy("AgentPoolV43UserEscrowKernel", [
  token,
  deployer,
]);
const coreVault = await deploy("AgentPoolV43EpochVault", [
  token,
  keccak256(toBytes("CORE")),
  genesisStart,
  parseEther(config.emission.coreWeeklyCapApool),
  parseEther(config.emission.coreLifetimeCapApool),
  deployer,
]);
const evolutionVault = await deploy("AgentPoolV43EpochVault", [
  token,
  keccak256(toBytes("EVOLUTION")),
  genesisStart,
  parseEther(config.emission.evolutionWeeklyCapApool),
  parseEther(config.emission.evolutionLifetimeCapApool),
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
const evolutionConsensus = await deploy("AgentPoolV43EvolutionConsensus", [
  token,
  ledger,
  releaseRegistry,
  financeInvariantHash,
  genesisRelease,
  proposalBond,
]);
const verifier = await deploy("AgentPoolV43HashObjectiveVerifier");
const verifierCode = await vm.stateManager.getCode(
  createAddressFromString(verifier),
);
const bootstrap = buildBootstrapTerms({
  config,
  releaseInputs,
  verifier,
});
const systemIssueGate = await deploy("AgentPoolV435SystemIssueGate", [
  bootstrap.issueRoot,
  token,
  ledger,
  deployer,
  keccak256(bytesToHex(verifierCode)),
  bootstrap.validatorRoot,
  parseEther(config.dynamicIssues.candidateBudgetCapApool),
  parseEther(config.dynamicIssues.issueBudgetCapApool),
  config.dynamicIssues.maxCandidates,
  config.dynamicIssues.maxLifetimeSeconds,
  dynamicCandidateBond,
]);
const transitionConsensus = await deploy(
  "AgentPoolV435TransitionIssueConsensus",
  [token, ledger, systemIssueGate, proposalBond],
);
const issueConsensus = await deploy("AgentPoolV432IssueConsensus", [
  token,
  ledger,
  systemIssueGate,
  proposalBond,
]);
const taskMarket = await deploy("AgentPoolV432TaskMarket", [
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

await write("AgentPoolV44Token", token, "configureMinters", [
  coreVault,
  evolutionVault,
]);
for (const vault of [coreVault, evolutionVault]) {
  await write("AgentPoolV43EpochVault", vault, "configureMarket", [
    taskMarket,
  ]);
}
for (const [name, address] of [
  ["AgentPoolV43UserEscrowKernel", userEscrow],
  ["AgentPoolV43CapacityRegistry", capacityRegistry],
  ["AgentPoolV432ProofRegistry", proofRegistry],
]) {
  await write(name, address, "configureMarket", [taskMarket]);
}
await write(
  "AgentPoolV43ContributionLedger",
  ledger,
  "configureConsensus",
  [evolutionConsensus],
);
await write(
  "AgentPoolV43ReleaseRegistry",
  releaseRegistry,
  "configureConsensus",
  [evolutionConsensus],
);
await write("AgentPoolV43SettlementRouter", settlementRouter, "configure", [
  ledger,
  evolutionConsensus,
  taskMarket,
]);
await write("AgentPoolV435SystemIssueGate", systemIssueGate, "configure", [
  taskMarket,
  transitionConsensus,
  issueConsensus,
]);

for (const [name, address, field] of [
  ["AgentPoolV44Token", token, "configurationAuthority"],
  ["AgentPoolV43SettlementRouter", settlementRouter, "configurationAuthority"],
  ["AgentPoolV43ReleaseRegistry", releaseRegistry, "configurationAuthority"],
  ["AgentPoolV43CapacityRegistry", capacityRegistry, "configurationAuthority"],
  ["AgentPoolV43UserEscrowKernel", userEscrow, "configurationAuthority"],
  ["AgentPoolV43EpochVault", coreVault, "configurationAuthority"],
  ["AgentPoolV43EpochVault", evolutionVault, "configurationAuthority"],
  ["AgentPoolV43ContributionLedger", ledger, "bootstrapAuthority"],
  ["AgentPoolV432ProofRegistry", proofRegistry, "configurationAuthority"],
  ["AgentPoolV435SystemIssueGate", systemIssueGate, "configurationAuthority"],
]) {
  check(
    `${name}.${field}.renounced`,
    await read(name, address, field),
    ZERO_ADDRESS,
  );
}
check(
  "exactGraph.dynamicCandidateBond",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "dynamicCandidateBond",
  ),
  dynamicCandidateBond,
);
check(
  "exactGraph.bootstrapRoot",
  await read(
    "AgentPoolV435SystemIssueGate",
    systemIssueGate,
    "bootstrapRoot",
  ),
  bootstrap.issueRoot,
);
await expectRevert("token.directMintIsUnavailable", () =>
  write("AgentPoolV44Token", token, "mint", [deployer, parseEther("1")]),
);

await write("AgentPoolV43ContributionLedger", ledger, "register", [
  proposerGroup,
  keccak256(toBytes("v44-proposer-runtime")),
]);
await write(
  "AgentPoolV43ContributionLedger",
  ledger,
  "register",
  [workerGroup, workerRuntime],
  workerKey,
);
for (let index = 0; index < validators.length; index++) {
  await write(
    "AgentPoolV43ContributionLedger",
    ledger,
    "register",
    [validators[index].group, validatorRuntime[index]],
    validators[index].key,
  );
}

blockTimestamp = BigInt(genesisStart + 1);
const capability = bootstrapObjectives[0].capabilityHash;
await write(
  "AgentPoolV43CapacityRegistry",
  capacityRegistry,
  "publish",
  [
    capability,
    config.bootstrap.capacityUnits,
    Number(blockTimestamp + 7n * 86_400n),
    workerRuntime,
  ],
  workerKey,
);

const allocation = parseEther("4");
const keeperFee = parseEther("1");
const terms = bootstrap.objectives.map((objective, index) => ({
  worker,
  verifier,
  capability: objective.capabilityHash,
  specificationHash: objective.specificationHash,
  expectedEvidenceHash: objective.expectedEvidenceHash,
  payoutRoot: payoutRoot([worker], [allocation]),
  allocation,
  workerBond: 0n,
  keeperFee,
  deadline: Number(blockTimestamp + 86_400n + BigInt(index * 300)),
  capacityUnits: objective.capacityUnits,
  minimumReveals: config.bootstrap.minimumReveals,
  passScoreBps: config.bootstrap.passScoreBps,
  commitWindow: 60,
  revealWindow: 60,
}));
const policies = terms.map(() => ({
  validatorRoot: bootstrap.validatorRoot,
  minimumOperatorGroups: config.bootstrap.minimumValidatorGroups,
}));
const dependencies = terms.map(() => 0);
const objectiveProofs = bootstrap.objectives.map(
  (objective) => objective.proof,
);
const planHash = keccak256(toBytes("v44-exact-bootstrap-plan"));
const nonce = await read(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "nextJobNonce",
);
const jobId = jobIdFor(taskMarket, deployer, nonce, planHash);
const budget = parseEther(config.bootstrap.totalBudgetCapApool);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "createSystemJobV2",
  [
    config.bootstrap.funding,
    budget,
    planHash,
    genesisRelease,
    bootstrap.issue,
    [],
    terms,
    policies,
    dependencies,
    objectiveProofs,
  ],
);

for (let milestoneIndex = 0; milestoneIndex < terms.length; milestoneIndex++) {
  const objective = bootstrapObjectives[milestoneIndex];
  await write(
    "AgentPoolV432TaskMarket",
    taskMarket,
    "acceptMilestone",
    [jobId, milestoneIndex],
    workerKey,
  );
  await write(
    "AgentPoolV432TaskMarket",
    taskMarket,
    "deliver",
    [jobId, milestoneIndex, objective.deliveryHash],
    workerKey,
  );
  const roundId = proofRoundId(jobId, milestoneIndex);
  const salts = validators.map((_, validatorIndex) =>
    keccak256(
      toBytes(`v44-proof-salt-${milestoneIndex}-${validatorIndex}`),
    ),
  );
  const evidenceHashes = validators.map((_, validatorIndex) =>
    keccak256(
      toBytes(`v44-proof-evidence-${milestoneIndex}-${validatorIndex}`),
    ),
  );
  for (let validatorIndex = 0; validatorIndex < validators.length; validatorIndex++) {
    const validator = validators[validatorIndex];
    const commitment = await read(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "commitmentFor",
      [
        roundId,
        validator.address,
        9_500,
        evidenceHashes[validatorIndex],
        salts[validatorIndex],
      ],
    );
    await write(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "commitWithProof",
      [
        roundId,
        commitment,
        bootstrap.validators[validatorIndex].proof,
      ],
      validator.key,
    );
  }
  blockTimestamp += 61n;
  for (let validatorIndex = 0; validatorIndex < validators.length; validatorIndex++) {
    await write(
      "AgentPoolV432ProofRegistry",
      proofRegistry,
      "reveal",
      [
        roundId,
        9_500,
        evidenceHashes[validatorIndex],
        salts[validatorIndex],
      ],
      validators[validatorIndex].key,
    );
  }
  blockTimestamp += 61n;
  await write("AgentPoolV432TaskMarket", taskMarket, "resolve", [
    jobId,
    milestoneIndex,
    objective.objectiveProof,
    [worker],
    [allocation],
  ]);
}

const job = await read("AgentPoolV432TaskMarket", taskMarket, "jobs", [
  jobId,
]);
check("exactBootstrap.jobSettled", job[2], 4);
check(
  "exactBootstrap.totalSupply",
  await read("AgentPoolV44Token", token, "totalSupply"),
  budget,
);
check(
  "exactBootstrap.workerReceivesTwentyFourAllocations",
  await read("AgentPoolV44Token", token, "balanceOf", [worker]),
  allocation * BigInt(terms.length),
);
check(
  "exactBootstrap.keeperReceivesTwentyFourFees",
  await read("AgentPoolV44Token", token, "balanceOf", [deployer]),
  keeperFee * BigInt(terms.length),
);
const usage = await read(
  "AgentPoolV435SystemIssueGate",
  systemIssueGate,
  "usage",
  [bootstrap.issue.issueId],
);
check("exactBootstrap.candidateSlotReleased", usage[2], 0);
check("exactBootstrap.reservedBudgetReleased", usage[1], 0n);
check(
  "exactBootstrap.vaultReservationReleased",
  await read("AgentPoolV43EpochVault", evolutionVault, "totalReserved"),
  0n,
);
check(
  "exactBootstrap.noCandidateBondWasNeededBeforeEmission",
  await read("AgentPoolV44Token", token, "balanceOf", [systemIssueGate]),
  0n,
);

const unregisteredEvidence = deterministicEvidence("v44-unregistered-worker");
const unregisteredPlan = keccak256(toBytes("v44-unregistered-plan"));
const unregisteredNonce = await read(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "nextJobNonce",
);
const unregisteredJobId = jobIdFor(
  taskMarket,
  deployer,
  unregisteredNonce,
  unregisteredPlan,
);
const unregisteredTerms = [
  {
    worker: initiallyUnregisteredWorker,
    verifier,
    capability,
    specificationHash: unregisteredEvidence.specificationHash,
    expectedEvidenceHash: unregisteredEvidence.expectedEvidenceHash,
    payoutRoot: payoutRoot([initiallyUnregisteredWorker], [parseEther("1")]),
    allocation: parseEther("1"),
    workerBond: 0n,
    keeperFee: parseEther("1"),
    deadline: Number(blockTimestamp + 86_400n),
    capacityUnits: 1,
    minimumReveals: 0,
    passScoreBps: 0,
    commitWindow: 0,
    revealWindow: 0,
  },
];
const noPanelPolicy = [
  {
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
  },
];
const externalBudget = parseEther("2");
await write("AgentPoolV44Token", token, "approve", [
  userEscrow,
  externalBudget,
]);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "createExternalJobV2",
  [
    externalBudget,
    unregisteredPlan,
    genesisRelease,
    unregisteredTerms,
    noPanelPolicy,
    [0],
  ],
);
await expectRevert(
  "external.unregisteredWorkerCannotAccept",
  () =>
    write(
      "AgentPoolV432TaskMarket",
      taskMarket,
      "acceptMilestone",
      [unregisteredJobId, 0],
      initiallyUnregisteredKey,
    ),
);
const newlyRegisteredGroup = keccak256(
  toBytes("v44-newly-registered-worker-group"),
);
const newlyRegisteredRuntime = keccak256(
  toBytes("v44-newly-registered-worker-runtime"),
);
await write(
  "AgentPoolV43ContributionLedger",
  ledger,
  "register",
  [newlyRegisteredGroup, newlyRegisteredRuntime],
  initiallyUnregisteredKey,
);
await write(
  "AgentPoolV43CapacityRegistry",
  capacityRegistry,
  "publish",
  [
    capability,
    1,
    Number(blockTimestamp + 7n * 86_400n),
    newlyRegisteredRuntime,
  ],
  initiallyUnregisteredKey,
);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "acceptMilestone",
  [unregisteredJobId, 0],
  initiallyUnregisteredKey,
);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "deliver",
  [unregisteredJobId, 0, unregisteredEvidence.deliveryHash],
  initiallyUnregisteredKey,
);
await write("AgentPoolV432TaskMarket", taskMarket, "resolve", [
  unregisteredJobId,
  0,
  unregisteredEvidence.proof,
  [initiallyUnregisteredWorker],
  [parseEther("1")],
]);
check(
  "external.registrationEnablesAcceptanceWithoutMinting",
  await read("AgentPoolV44Token", token, "totalSupply"),
  budget,
);

const noQuorumEvidence = deterministicEvidence("v44-no-quorum-refund");
const noQuorumPlan = keccak256(toBytes("v44-no-quorum-plan"));
const noQuorumNonce = await read(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "nextJobNonce",
);
const noQuorumJobId = jobIdFor(
  taskMarket,
  deployer,
  noQuorumNonce,
  noQuorumPlan,
);
const workerBond = parseEther("1");
const noQuorumTerms = [
  {
    worker: initiallyUnregisteredWorker,
    verifier,
    capability,
    specificationHash: noQuorumEvidence.specificationHash,
    expectedEvidenceHash: noQuorumEvidence.expectedEvidenceHash,
    payoutRoot: payoutRoot([initiallyUnregisteredWorker], [parseEther("1")]),
    allocation: parseEther("1"),
    workerBond,
    keeperFee: parseEther("1"),
    deadline: Number(blockTimestamp + 86_400n),
    capacityUnits: 1,
    minimumReveals: 3,
    passScoreBps: 8_000,
    commitWindow: 60,
    revealWindow: 60,
  },
];
const noQuorumPolicy = [
  {
    validatorRoot: bootstrap.validatorRoot,
    minimumOperatorGroups: 3,
  },
];
await write("AgentPoolV44Token", token, "approve", [
  userEscrow,
  externalBudget,
]);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "createExternalJobV2",
  [
    externalBudget,
    noQuorumPlan,
    genesisRelease,
    noQuorumTerms,
    noQuorumPolicy,
    [0],
  ],
);
await write(
  "AgentPoolV44Token",
  token,
  "approve",
  [taskMarket, workerBond],
  initiallyUnregisteredKey,
);
const bondedWorkerBalance = await read(
  "AgentPoolV44Token",
  token,
  "balanceOf",
  [initiallyUnregisteredWorker],
);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "acceptMilestone",
  [noQuorumJobId, 0],
  initiallyUnregisteredKey,
);
await write(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "deliver",
  [noQuorumJobId, 0, noQuorumEvidence.deliveryHash],
  initiallyUnregisteredKey,
);
blockTimestamp += 121n;
await write("AgentPoolV432TaskMarket", taskMarket, "resolve", [
  noQuorumJobId,
  0,
  noQuorumEvidence.proof,
  [initiallyUnregisteredWorker],
  [parseEther("1")],
]);
const noQuorumJob = await read(
  "AgentPoolV432TaskMarket",
  taskMarket,
  "jobs",
  [noQuorumJobId],
);
check("external.noQuorumRefundsJob", noQuorumJob[2], 6);
check(
  "external.noQuorumReturnsHonestWorkerBond",
  await read("AgentPoolV44Token", token, "balanceOf", [
    initiallyUnregisteredWorker,
  ]),
  bondedWorkerBalance,
);
check(
  "external.noQuorumNeverMints",
  await read("AgentPoolV44Token", token, "totalSupply"),
  budget,
);

const report = {
  schema: "agentpool.mainnet.v44.exact-graph-rehearsal/v2",
  ok: checks.every((entry) => entry.passed),
  chainId: 8453,
  configSha256: configEvidence.configSha256,
  financeInvariantHash,
  bootstrapObjectiveCount: bootstrapObjectives.length,
  contracts: {
    token,
    settlementRouter,
    releaseRegistry,
    capacityRegistry,
    userEscrow,
    coreVault,
    evolutionVault,
    contributionLedger: ledger,
    proofRegistry,
    evolutionConsensus,
    verifier,
    systemIssueGate,
    transitionConsensus,
    issueConsensus,
    taskMarket,
  },
  transactions: transactionCount,
  gasSpent: gasSpent.toString(),
  checks,
  generatedAt: new Date().toISOString(),
};
const reportPath = path.join(
  ROOT,
  "outputs",
  "v44-full-mainnet-candidate-rehearsal.json",
);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) {
  throw new Error(`V44_FULL_REHEARSAL_FAILED:${reportPath}`);
}
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      transactions: transactionCount,
      checks: checks.length,
      bootstrapObjectives: bootstrapObjectives.length,
      reportPath,
    },
    null,
    2,
  )}\n`,
);
