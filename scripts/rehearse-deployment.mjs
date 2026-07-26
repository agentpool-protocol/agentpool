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
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const outputDirectory = path.join(root, "outputs", "deployments");
fs.mkdirSync(outputDirectory, { recursive: true });

const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v2 Local Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("Failed to configure the local EVM");
const vm = await createVM({ common, activatePrecompiles: true });

const privateKey = hexToBytes(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const deployer = createAddressFromPrivateKey(privateKey);
const deployerAddress = getAddress(deployer.toString());
function rehearsalKey(index) {
  return hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
}
function addressFor(key) {
  return getAddress(createAddressFromPrivateKey(key).toString());
}
function accountFor(key) {
  return privateKeyToAccount(bytesToHex(key));
}

const roleKeys = {
  governance: rehearsalKey(2),
  ecosystem: rehearsalKey(3),
  operations: rehearsalKey(4),
  validatorTreasury: rehearsalKey(5),
  author: rehearsalKey(6),
  liquidity: rehearsalKey(7),
  founder: rehearsalKey(8),
  security: rehearsalKey(9),
};
const roles = Object.fromEntries(
  Object.entries(roleKeys).map(([name, key]) => [name, addressFor(key)]),
);
const verifierKey = rehearsalKey(10);
const verifierAdapter = addressFor(verifierKey);
const validatorKeys = Array.from({ length: 5 }, (_, index) => rehearsalKey(index + 11));
const validators = validatorKeys.map(addressFor);
const buyerKey = rehearsalKey(16);
const sellerKey = rehearsalKey(17);
const coordinatorKey = rehearsalKey(18);
const workerTwoKey = rehearsalKey(19);
const buyer = addressFor(buyerKey);
const seller = addressFor(sellerKey);
const coordinator = addressFor(coordinatorKey);
const workerTwo = addressFor(workerTwoKey);
const allKeys = [
  privateKey,
  ...Object.values(roleKeys),
  verifierKey,
  ...validatorKeys,
  buyerKey,
  sellerKey,
  coordinatorKey,
  workerTwoKey,
];
for (const key of allKeys) {
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(key),
    createAccount({ nonce: 0n, balance: parseEther("10000") }),
  );
}

const artifactCache = new Map();
function artifact(name) {
  if (!artifactCache.has(name)) {
    const artifactPath = path.join(root, "artifacts", `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Missing contract artifact: ${artifactPath}`);
    }
    artifactCache.set(name, JSON.parse(fs.readFileSync(artifactPath, "utf8")));
  }
  return artifactCache.get(name);
}

let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
let transactionCount = 0;
let gasSpent = 0n;
function advanceTime(seconds) {
  blockTimestamp += BigInt(seconds);
}
async function execute(data, to, signingKey = privateKey) {
  const signer = createAddressFromPrivateKey(signingKey);
  const signerAccount = await vm.stateManager.getAccount(signer);
  const nonce = signerAccount?.nonce ?? 0n;
  const tx = createLegacyTx(
    {
      nonce,
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
  blockNumber += 1n;
  blockTimestamp += 1n;
  transactionCount += 1;
  gasSpent += result.totalGasSpent;
  if (result.execResult.exceptionError) {
    const returnData = bytesToHex(result.execResult.returnValue);
    throw new Error(
      `Local EVM transaction ${nonce} reverted: ${result.execResult.exceptionError.error}; data=${returnData}`,
    );
  }
  return result;
}
async function deploy(name, args = []) {
  const compiled = artifact(name);
  const result = await execute(
    encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args }),
  );
  if (!result.createdAddress) throw new Error(`${name} did not return a contract address`);
  const address = getAddress(result.createdAddress.toString());
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0) throw new Error(`${name} has no deployed bytecode`);
  return address;
}
async function write(name, address, functionName, args = [], signingKey = privateKey) {
  return execute(
    encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    address,
    signingKey,
  );
}
async function read(name, address, functionName, args = []) {
  const result = await vm.evm.runCall({
    caller: deployer,
    origin: deployer,
    to: createAddressFromString(address),
    data: hexToBytes(
      encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    ),
    gasLimit: 30_000_000n,
    isStatic: true,
  });
  if (result.execResult.exceptionError) {
    throw new Error(`${name}.${functionName} static call reverted`);
  }
  return decodeFunctionResult({
    abi: artifact(name).abi,
    functionName,
    data: bytesToHex(result.execResult.returnValue),
  });
}
async function expectRevert(label, action) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
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
  if (!passed) {
    throw new Error(
      `${name}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function sortedPairHash(left, right) {
  const [first, second] =
    BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return keccak256(concatHex([first, second]));
}

const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const verifierIds = protocolConfig.bootstrapVerifierNames.map((name) =>
  keccak256(toBytes(name)),
);
const verifierImplementationHash = keccak256(
  toBytes("agentpool.rehearsal.verifier.implementation.v2"),
);
const genesis = blockTimestamp;
const founderVesting = await deploy("AgentPoolFounderVesting", [
  roles.founder,
  genesis,
]);
const benchmarkRewardVault = await deploy("AgentPoolBenchmarkRewardVault", [
  deployerAddress,
  validators,
  genesis,
  1,
  1_000_000n,
]);
const token = await deploy("AgentPoolToken", [
  benchmarkRewardVault,
  roles.ecosystem,
  roles.operations,
  roles.validatorTreasury,
  roles.author,
  roles.liquidity,
  founderVesting,
  roles.security,
]);
await write(
  "AgentPoolBenchmarkRewardVault",
  benchmarkRewardVault,
  "configureToken",
  [token],
);
const timelock = await deploy("TimelockController", [
  7n * 24n * 60n * 60n,
  [roles.governance],
  [zeroAddress],
  deployerAddress,
]);
const registry = await deploy("AgentPoolRegistry", [deployerAddress]);
const license = await deploy("AgentPoolLicense", [
  "https://agentpool-protocol.asfu.chatgpt.site/api/v1/licenses/{id}.json",
]);
const randomnessProvider = await deploy("MockRandomnessProvider", [deployerAddress]);
const oracle = await deploy("AgentPoolWorkOracle", [
  deployerAddress,
  registry,
  randomnessProvider,
]);
const jobEscrow = await deploy("AgentPoolJobEscrow", [
  token,
  registry,
  deployerAddress,
  roles.security,
]);
const projectResolver = await deploy("AgentPoolProjectResolver", [
  deployerAddress,
  validators,
  1,
]);
const projectEscrow = await deploy("AgentPoolProjectEscrow", [
  token,
  registry,
  deployerAddress,
  roles.security,
]);
await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
for (const verifierId of verifierIds) {
  await write("AgentPoolRegistry", registry, "configureVerifier", [
    verifierId,
    verifierAdapter,
    verifierImplementationHash,
    false,
    true,
  ]);
}
for (const validator of validators) {
  await write("AgentPoolWorkOracle", oracle, "setEvaluator", [validator, true]);
}
await write("AgentPoolWorkOracle", oracle, "setEscrow", [jobEscrow]);
await write("AgentPoolJobEscrow", jobEscrow, "setResolver", [oracle]);
await write(
  "AgentPoolProjectResolver",
  projectResolver,
  "configureProjectEscrow",
  [projectEscrow],
);
await write("AgentPoolProjectEscrow", projectEscrow, "setResolver", [projectResolver]);

check("token.totalSupply", await read("AgentPoolToken", token, "totalSupply"), 1_000_000_000_000n);
check("token.decimals", await read("AgentPoolToken", token, "decimals"), 0);
check(
  "token.benchmarkAllocation",
  await read("AgentPoolToken", token, "balanceOf", [benchmarkRewardVault]),
  400_000_000_000n,
);
check(
  "token.founderAllocation",
  await read("AgentPoolToken", token, "balanceOf", [founderVesting]),
  50_000_000_000n,
);
check(
  "job.minimumValidationFee",
  await read("AgentPoolJobEscrow", jobEscrow, "validationFeeFor", [1n]),
  10n,
);
check(
  "project.minimumValidationFee",
  await read("AgentPoolProjectEscrow", projectEscrow, "validationFeeFor", [1n]),
  10n,
);

const benchmarkReceipt = {
  challengeId: keccak256(toBytes("challenge-1")),
  submissionHash: keccak256(toBytes("submission-1")),
  minerId: keccak256(toBytes("miner-1")),
  recipient: buyer,
  trackId: keccak256(toBytes("code")),
  leagueId: keccak256(toBytes("container")),
  policyVersion: 1,
  accuracyBps: 10_000,
  efficiencyBps: 2_000,
  baseReward: 100n,
  reward: 120n,
  day: 0n,
  expiresAt: blockTimestamp + 3_600n,
};
const benchmarkTypes = {
  RewardReceipt: [
    { name: "challengeId", type: "bytes32" },
    { name: "submissionHash", type: "bytes32" },
    { name: "minerId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "trackId", type: "bytes32" },
    { name: "leagueId", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
    { name: "accuracyBps", type: "uint16" },
    { name: "efficiencyBps", type: "uint16" },
    { name: "baseReward", type: "uint128" },
    { name: "reward", type: "uint128" },
    { name: "day", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};
const benchmarkSignatures = await Promise.all(
  validatorKeys.slice(0, 3).map((key) =>
    accountFor(key).signTypedData({
      domain: {
        name: "AgentPool Benchmark Mining",
        version: "2",
        chainId: 31337,
        verifyingContract: benchmarkRewardVault,
      },
      types: benchmarkTypes,
      primaryType: "RewardReceipt",
      message: benchmarkReceipt,
    }),
  ),
);
await expectRevert("benchmark two-signature quorum", () =>
  write(
    "AgentPoolBenchmarkRewardVault",
    benchmarkRewardVault,
    "claim",
    [benchmarkReceipt, benchmarkSignatures.slice(0, 2)],
    buyerKey,
  ),
);
await write(
  "AgentPoolBenchmarkRewardVault",
  benchmarkRewardVault,
  "claim",
  [benchmarkReceipt, benchmarkSignatures],
  buyerKey,
);
check("benchmark.immediateReward", await read("AgentPoolToken", token, "balanceOf", [buyer]), 120n);
await expectRevert("benchmark receipt replay", () =>
  write(
    "AgentPoolBenchmarkRewardVault",
    benchmarkRewardVault,
    "claim",
    [benchmarkReceipt, benchmarkSignatures],
    buyerKey,
  ),
);

await write("AgentPoolToken", token, "transfer", [buyer, 20_000n], roleKeys.ecosystem);
await write("AgentPoolToken", token, "transfer", [seller, 1_000n], roleKeys.ecosystem);
await write("AgentPoolToken", token, "transfer", [workerTwo, 1_000n], roleKeys.ecosystem);
await write("AgentPoolToken", token, "approve", [jobEscrow, 10_000n], buyerKey);
await write("AgentPoolToken", token, "approve", [jobEscrow, 1_000n], sellerKey);
const supplyBeforeJob = await read("AgentPoolToken", token, "totalSupply");
const sellerBeforeJob = await read("AgentPoolToken", token, "balanceOf", [seller]);
const validatorBeforeJob = await read(
  "AgentPoolToken",
  token,
  "balanceOf",
  [verifierAdapter],
);
const securityBeforeJob = await read(
  "AgentPoolToken",
  token,
  "balanceOf",
  [roles.security],
);
const jobDeadline = blockTimestamp + 3_600n;
await write("AgentPoolJobEscrow", jobEscrow, "fundJob", [
  seller,
  1_000n,
  100n,
  jobDeadline,
  keccak256(toBytes("job-requirements")),
  verifierIds[0],
], buyerKey);
await write("AgentPoolJobEscrow", jobEscrow, "acceptJob", [1n], sellerKey);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "submitJob",
  [1n, keccak256(toBytes("job-delivery"))],
  sellerKey,
);
await write(
  "AgentPoolWorkOracle",
  oracle,
  "proposeOutcome",
  [1n, verifierIds[0], 0],
  verifierKey,
);
advanceTime(2 * 60 * 60 + 1);
await write("AgentPoolWorkOracle", oracle, "finalizeUnchallenged", [1n]);
check(
  "job.workerReceivesFullPrice",
  await read("AgentPoolToken", token, "balanceOf", [seller]),
  sellerBeforeJob + 1_000n,
);
check(
  "job.validatorShare",
  await read("AgentPoolToken", token, "balanceOf", [verifierAdapter]),
  validatorBeforeJob + 21n,
);
check(
  "job.securityShare",
  await read("AgentPoolToken", token, "balanceOf", [roles.security]),
  securityBeforeJob + 3n,
);
check(
  "job.burn",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeJob - 6n,
);
check("job.completed", await read("AgentPoolJobEscrow", jobEscrow, "jobState", [1n]), 6);

const buyerBeforeAmbiguous = await read("AgentPoolToken", token, "balanceOf", [buyer]);
const sellerBeforeAmbiguous = await read("AgentPoolToken", token, "balanceOf", [seller]);
const securityBeforeAmbiguous = await read(
  "AgentPoolToken",
  token,
  "balanceOf",
  [roles.security],
);
const supplyBeforeAmbiguous = await read("AgentPoolToken", token, "totalSupply");
await write("AgentPoolJobEscrow", jobEscrow, "fundJob", [
  seller,
  500n,
  50n,
  blockTimestamp + 3_600n,
  keccak256(toBytes("ambiguous-requirements")),
  verifierIds[0],
], buyerKey);
await write("AgentPoolJobEscrow", jobEscrow, "acceptJob", [2n], sellerKey);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "submitJob",
  [2n, keccak256(toBytes("ambiguous-delivery"))],
  sellerKey,
);
await write(
  "AgentPoolWorkOracle",
  oracle,
  "proposeOutcome",
  [2n, verifierIds[0], 2],
  verifierKey,
);
advanceTime(2 * 60 * 60 + 1);
await write("AgentPoolWorkOracle", oracle, "finalizeUnchallenged", [2n]);
check(
  "ambiguous.buyerFullRefund",
  await read("AgentPoolToken", token, "balanceOf", [buyer]),
  buyerBeforeAmbiguous,
);
check(
  "ambiguous.sellerBondReturned",
  await read("AgentPoolToken", token, "balanceOf", [seller]),
  sellerBeforeAmbiguous,
);
check(
  "ambiguous.noSecurityFee",
  await read("AgentPoolToken", token, "balanceOf", [roles.security]),
  securityBeforeAmbiguous,
);
check(
  "ambiguous.noBurn",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeAmbiguous,
);

await write("AgentPoolToken", token, "approve", [projectEscrow, 10_000n], buyerKey);
await write("AgentPoolToken", token, "approve", [projectEscrow, 1_000n], sellerKey);
await write("AgentPoolToken", token, "approve", [projectEscrow, 1_000n], workerTwoKey);
const projectDeadline = blockTimestamp + 7_200n;
await write("AgentPoolProjectEscrow", projectEscrow, "createProject", [
  coordinator,
  2_000n,
  2,
  2,
  projectDeadline,
  keccak256(toBytes("project-brief")),
], buyerKey);
const projectTaskSpecs = [
  {
    worker: seller,
    title: "task-one",
    dependencies: [],
    signingKey: sellerKey,
  },
  {
    worker: workerTwo,
    title: "task-two",
    dependencies: [1n],
    signingKey: workerTwoKey,
  },
].map((task) => ({
  ...task,
  price: 1_000n,
  deadline: projectDeadline - 600n,
  requirementsHash: keccak256(toBytes(`${task.title}-requirements`)),
}));
const projectTaskLeaves = [];
for (const task of projectTaskSpecs) {
  const dependenciesHash = keccak256(
    encodeAbiParameters([{ type: "uint256[]" }], [task.dependencies]),
  );
  projectTaskLeaves.push(
    await read("AgentPoolProjectEscrow", projectEscrow, "taskLeaf", [
      1n,
      task.worker,
      task.price,
      task.deadline,
      task.requirementsHash,
      dependenciesHash,
      verifierIds[0],
    ]),
  );
}
const projectPlanRoot = sortedPairHash(projectTaskLeaves[0], projectTaskLeaves[1]);
await write(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "postPlan",
  [1n, projectPlanRoot, 2],
  coordinatorKey,
);
await expectRevert("project task before buyer approval", () =>
  write(
    "AgentPoolProjectEscrow",
    projectEscrow,
    "addTask",
    [
      1n,
      projectTaskSpecs[0].worker,
      projectTaskSpecs[0].price,
      projectTaskSpecs[0].deadline,
      projectTaskSpecs[0].requirementsHash,
      projectTaskSpecs[0].dependencies,
      verifierIds[0],
      [projectTaskLeaves[1]],
    ],
    coordinatorKey,
  ),
);
await write("AgentPoolProjectEscrow", projectEscrow, "approvePlan", [1n], buyerKey);
for (let index = 0; index < projectTaskSpecs.length; index++) {
  const task = projectTaskSpecs[index];
  await write(
    "AgentPoolProjectEscrow",
    projectEscrow,
    "addTask",
    [
      1n,
      task.worker,
      task.price,
      task.deadline,
      task.requirementsHash,
      task.dependencies,
      verifierIds[0],
      [projectTaskLeaves[index === 0 ? 1 : 0]],
    ],
    coordinatorKey,
  );
  if (index === 0) {
    await expectRevert("project plan leaf replay", () =>
      write(
        "AgentPoolProjectEscrow",
        projectEscrow,
        "addTask",
        [
          1n,
          task.worker,
          task.price,
          task.deadline,
          task.requirementsHash,
          task.dependencies,
          verifierIds[0],
          [projectTaskLeaves[1]],
        ],
        coordinatorKey,
      ),
    );
  }
}
await write("AgentPoolProjectEscrow", projectEscrow, "acceptTask", [1n], sellerKey);
await write(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "submitTask",
  [1n, keccak256(toBytes("task-one-delivery"))],
  sellerKey,
);
await expectRevert("project dependency before pass", () =>
  write(
    "AgentPoolProjectEscrow",
    projectEscrow,
    "acceptTask",
    [2n],
    workerTwoKey,
  ),
);

const projectTypes = {
  TaskResolution: [
    { name: "taskId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
};
async function resolveProjectTask(taskId, outcome) {
  const resolution = {
    taskId,
    outcome,
    evidenceHash: keccak256(toBytes(`task-${taskId}-evidence`)),
    policyVersion: 1,
    expiresAt: blockTimestamp + 3_600n,
  };
  const signatures = await Promise.all(
    validatorKeys.slice(0, 3).map((key) =>
      accountFor(key).signTypedData({
        domain: {
          name: "AgentPool Project Resolver",
          version: "2",
          chainId: 31337,
          verifyingContract: projectResolver,
        },
        types: projectTypes,
        primaryType: "TaskResolution",
        message: resolution,
      }),
    ),
  );
  await write(
    "AgentPoolProjectResolver",
    projectResolver,
    "resolve",
    [resolution, signatures],
  );
}
const buyerBeforeFinalize = await read("AgentPoolToken", token, "balanceOf", [buyer]);
const supplyBeforeProjectResolution = await read("AgentPoolToken", token, "totalSupply");
await resolveProjectTask(1n, 0);
await write("AgentPoolProjectEscrow", projectEscrow, "acceptTask", [2n], workerTwoKey);
await write(
  "AgentPoolProjectEscrow",
  projectEscrow,
  "submitTask",
  [2n, keccak256(toBytes("task-two-delivery"))],
  workerTwoKey,
);
await resolveProjectTask(2n, 1);
await write("AgentPoolProjectEscrow", projectEscrow, "finalizeProject", [1n]);
check(
  "project.twoValidationBurns",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeProjectResolution - 12n,
);
check(
  "project.refundsUnusedBudget",
  await read("AgentPoolToken", token, "balanceOf", [buyer]),
  buyerBeforeFinalize + 1_010n,
);
const project = await read("AgentPoolProjectEscrow", projectEscrow, "projects", [1n]);
check("project.completed", project[12], 4);
check("project.distinctWorkers", project[16], 2);
check(
  "project.escrowConserved",
  await read("AgentPoolToken", token, "balanceOf", [projectEscrow]),
  0n,
);

const buyerBeforeStalled = await read("AgentPoolToken", token, "balanceOf", [buyer]);
const sellerBeforeStalled = await read("AgentPoolToken", token, "balanceOf", [seller]);
const supplyBeforeStalled = await read("AgentPoolToken", token, "totalSupply");
await write("AgentPoolJobEscrow", jobEscrow, "fundJob", [
  seller,
  100n,
  20n,
  blockTimestamp + 3_600n,
  keccak256(toBytes("stalled-requirements")),
  verifierIds[0],
], buyerKey);
await write("AgentPoolJobEscrow", jobEscrow, "acceptJob", [3n], sellerKey);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "submitJob",
  [3n, keccak256(toBytes("stalled-delivery"))],
  sellerKey,
);
advanceTime(3 * 24 * 60 * 60 + 1);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "refundStalledSubmission",
  [3n],
  coordinatorKey,
);
check(
  "stalled.buyerRefunded",
  await read("AgentPoolToken", token, "balanceOf", [buyer]),
  buyerBeforeStalled,
);
check(
  "stalled.sellerBondReturned",
  await read("AgentPoolToken", token, "balanceOf", [seller]),
  sellerBeforeStalled,
);
check(
  "stalled.noBurn",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeStalled,
);

const buyerBeforeVrfTimeout = await read("AgentPoolToken", token, "balanceOf", [buyer]);
const sellerBeforeVrfTimeout = await read("AgentPoolToken", token, "balanceOf", [seller]);
const supplyBeforeVrfTimeout = await read("AgentPoolToken", token, "totalSupply");
await write("AgentPoolJobEscrow", jobEscrow, "fundJob", [
  seller,
  100n,
  20n,
  blockTimestamp + 3_600n,
  keccak256(toBytes("vrf-timeout-requirements")),
  verifierIds[0],
], buyerKey);
await write("AgentPoolJobEscrow", jobEscrow, "acceptJob", [4n], sellerKey);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "submitJob",
  [4n, keccak256(toBytes("vrf-timeout-delivery"))],
  sellerKey,
);
await write(
  "AgentPoolWorkOracle",
  oracle,
  "proposeOutcome",
  [4n, verifierIds[0], 0],
  verifierKey,
);
await write("AgentPoolJobEscrow", jobEscrow, "challenge", [4n], buyerKey);
advanceTime(24 * 60 * 60 + 1);
await write("AgentPoolWorkOracle", oracle, "finalizeUnselected", [1n], coordinatorKey);
check(
  "vrfTimeout.buyerRefunded",
  await read("AgentPoolToken", token, "balanceOf", [buyer]),
  buyerBeforeVrfTimeout,
);
check(
  "vrfTimeout.sellerBondReturned",
  await read("AgentPoolToken", token, "balanceOf", [seller]),
  sellerBeforeVrfTimeout,
);
check(
  "vrfTimeout.noBurn",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeVrfTimeout,
);

const sellerBeforeDispute = await read("AgentPoolToken", token, "balanceOf", [seller]);
const supplyBeforeDispute = await read("AgentPoolToken", token, "totalSupply");
let validatorRewardsBeforeDispute = 0n;
for (const validator of validators) {
  validatorRewardsBeforeDispute += await read(
    "AgentPoolToken",
    token,
    "balanceOf",
    [validator],
  );
}
await write("AgentPoolJobEscrow", jobEscrow, "fundJob", [
  seller,
  100n,
  20n,
  blockTimestamp + 3_600n,
  keccak256(toBytes("dispute-requirements")),
  verifierIds[0],
], buyerKey);
await write("AgentPoolJobEscrow", jobEscrow, "acceptJob", [5n], sellerKey);
await write(
  "AgentPoolJobEscrow",
  jobEscrow,
  "submitJob",
  [5n, keccak256(toBytes("dispute-delivery"))],
  sellerKey,
);
await write(
  "AgentPoolWorkOracle",
  oracle,
  "proposeOutcome",
  [5n, verifierIds[0], 1],
  verifierKey,
);
await write("AgentPoolJobEscrow", jobEscrow, "challenge", [5n], buyerKey);
await write(
  "MockRandomnessProvider",
  randomnessProvider,
  "fulfill",
  [2n, 42n],
);
const selectedDisputeValidators = [];
for (let index = 0; index < 5; index++) {
  selectedDisputeValidators.push(
    await read(
      "AgentPoolWorkOracle",
      oracle,
      "selectedEvaluators",
      [2n, BigInt(index)],
    ),
  );
}
const validatorKeyByAddress = new Map(
  validators.map((address, index) => [address.toLowerCase(), validatorKeys[index]]),
);
const disputeVotes = [true, true, true, false, false];
const disputeSalts = selectedDisputeValidators.map((_, index) =>
  keccak256(toBytes(`dispute-salt-${index}`)),
);
for (let index = 0; index < selectedDisputeValidators.length; index++) {
  const evaluator = selectedDisputeValidators[index];
  const commitment = keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bool" },
        { type: "bytes32" },
      ],
      [2n, evaluator, disputeVotes[index], disputeSalts[index]],
    ),
  );
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "commitVote",
    [2n, commitment],
    validatorKeyByAddress.get(evaluator.toLowerCase()),
  );
}
advanceTime(60 * 60 + 1);
for (let index = 0; index < selectedDisputeValidators.length; index++) {
  const evaluator = selectedDisputeValidators[index];
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "revealVote",
    [2n, disputeVotes[index], disputeSalts[index]],
    validatorKeyByAddress.get(evaluator.toLowerCase()),
  );
}
advanceTime(60 * 60 + 1);
await write("AgentPoolWorkOracle", oracle, "finalize", [2n], coordinatorKey);
check(
  "dispute.workerReceivesFullPrice",
  await read("AgentPoolToken", token, "balanceOf", [seller]),
  sellerBeforeDispute + 100n,
);
let validatorRewardsAfterDispute = 0n;
for (const validator of validators) {
  validatorRewardsAfterDispute += await read(
    "AgentPoolToken",
    token,
    "balanceOf",
    [validator],
  );
}
check(
  "dispute.correctValidatorsPaid",
  validatorRewardsAfterDispute,
  validatorRewardsBeforeDispute + 7n,
);
check(
  "dispute.burn",
  await read("AgentPoolToken", token, "totalSupply"),
  supplyBeforeDispute - 2n,
);

for (const [name, address] of [
  ["AgentPoolBenchmarkRewardVault", benchmarkRewardVault],
  ["AgentPoolRegistry", registry],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", jobEscrow],
  ["AgentPoolProjectResolver", projectResolver],
  ["AgentPoolProjectEscrow", projectEscrow],
  ["MockRandomnessProvider", randomnessProvider],
]) {
  await write(name, address, "transferOwnership", [timelock]);
  check(`owner:${name}`, await read(name, address, "owner"), timelock);
}
await write("TimelockController", timelock, "revokeRole", [zeroHash, deployerAddress]);
const proposerRole = keccak256(toBytes("PROPOSER_ROLE"));
check(
  "timelock.multisigProposer",
  await read("TimelockController", timelock, "hasRole", [
    proposerRole,
    roles.governance,
  ]),
  true,
);
check(
  "timelock.deployerAdminRemoved",
  await read("TimelockController", timelock, "hasRole", [
    zeroHash,
    deployerAddress,
  ]),
  false,
);

const deployment = {
  version: 2,
  chainId: 31337,
  network: "AgentPool v2 Local Rehearsal",
  contracts: {
    founderVesting,
    benchmarkRewardVault,
    token,
    timelock,
    registry,
    license,
    randomnessProvider,
    oracle,
    jobEscrow,
    projectResolver,
    projectEscrow,
  },
  transactionCount,
  gasSpent: gasSpent.toString(),
  checks,
  status: "passed",
  generatedAt: new Date().toISOString(),
};
const target = path.join(outputDirectory, "local-rehearsal-v2.json");
fs.writeFileSync(target, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(
  `AgentPool v2 local rehearsal passed: ${transactionCount} transactions, ${checks.length} checks.`,
);
console.log(`Rehearsal evidence: ${target}`);
