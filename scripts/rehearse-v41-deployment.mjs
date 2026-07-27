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
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  keccak256,
  parseEther,
  toBytes,
  toHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v4.1 Local Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("LOCAL_EVM_COMMON_FAILED");
const vm = await createVM({ common, activatePrecompiles: true });

function rehearsalKey(index) {
  return hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
}
function addressFor(key) {
  return getAddress(createAddressFromPrivateKey(key).toString());
}
function accountFor(key) {
  return privateKeyToAccount(bytesToHex(key));
}

const deployerKey = hexToBytes(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const deployer = createAddressFromPrivateKey(deployerKey);
const deployerAddress = getAddress(deployer.toString());
const validatorEntries = Array.from({ length: 5 }, (_, index) => {
  const key = rehearsalKey(index + 2);
  return { key, address: addressFor(key), account: accountFor(key) };
}).sort((left, right) =>
  BigInt(left.address) < BigInt(right.address) ? -1 : 1);
const workerKey = rehearsalKey(20);
const buyerKey = rehearsalKey(21);
const plannerKey = rehearsalKey(22);
const worker = addressFor(workerKey);
const buyer = addressFor(buyerKey);
const planner = addressFor(plannerKey);
const allKeys = [
  deployerKey,
  ...validatorEntries.map((entry) => entry.key),
  workerKey,
  buyerKey,
  plannerKey,
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
    const file = path.join(root, "artifacts", `${name}.json`);
    artifactCache.set(name, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return artifactCache.get(name);
}

let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1_000));
let transactionCount = 0;
let gasSpent = 0n;

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
    throw new Error(`${name}.${functionName}_STATIC_REVERT`);
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
  throw new Error(`${label}_UNEXPECTEDLY_SUCCEEDED`);
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
  assertCondition(passed, `${name}: expected ${expected}, got ${actual}`);
}
function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const token = await deploy("AgentPoolV41Token", [deployerAddress]);
const verifier = await deploy("AgentPoolV41HashVerifier");
const genesisStart = Number(blockTimestamp);
const controller = await deploy("AgentPoolV41EmissionController", [
  token,
  deployerAddress,
  verifier,
  validatorEntries.map((entry) => entry.address),
  3,
  genesisStart,
]);
const releases = await deploy("AgentPoolV41ReleaseRegistry", [controller]);
const artifacts = await deploy("AgentPoolV41ArtifactRegistry", [controller]);
const userEscrow = await deploy("AgentPoolV41UserEscrow", [token]);
await write(
  "AgentPoolV41EmissionController",
  controller,
  "configureRegistries",
  [releases, artifacts],
);
await write(
  "AgentPoolV41Token",
  token,
  "setEmissionController",
  [controller],
);

check(
  "v4.1 begins with zero supply",
  await read("AgentPoolV41Token", token, "totalSupply"),
  0n,
);
check(
  "controller is the only configured minter",
  await read("AgentPoolV41Token", token, "emissionController"),
  controller,
);
await expectRevert("deployer cannot mint", () =>
  write("AgentPoolV41Token", token, "mint", [deployerAddress, parseEther("1")]),
);
await expectRevert("controller cannot be replaced", () =>
  write("AgentPoolV41Token", token, "setEmissionController", [deployerAddress]),
);

function predictedVault({
  epoch,
  lane,
  issueHash = zeroHash,
  experimental = false,
  salt,
}) {
  return getCreate2Address({
    from: controller,
    salt,
    bytecode: encodeDeployData({
      abi: artifact("AgentPoolV41EpochVault").abi,
      bytecode: artifact("AgentPoolV41EpochVault").bytecode,
      args: [controller, epoch, lane, issueHash, experimental],
    }),
  });
}

async function createVault(config) {
  const predicted = predictedVault(config);
  await write(
    "AgentPoolV41EmissionController",
    controller,
    "createEpochVault",
    [
      config.epoch,
      config.lane,
      config.issueHash ?? zeroHash,
      config.experimental ?? false,
      config.salt,
    ],
  );
  const code = await vm.stateManager.getCode(createAddressFromString(predicted));
  assertCondition(code.length > 0 && code.length <= 24_576, "vault code is not deployable");
  return predicted;
}

const basicVault = await createVault({
  epoch: 0,
  lane: 1,
  salt: keccak256(toBytes("basic-vault")),
});
check(
  "basic vault authorized",
  await read("AgentPoolV41EmissionController", controller, "isVault", [basicVault]),
  true,
);

function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}

async function admissionSignatures(vault, task) {
  const domain = {
    name: "AgentPool v4.1 EpochVault",
    version: "1",
    chainId: 31337,
    verifyingContract: vault,
  };
  const types = {
    TaskAdmission: [
      { name: "assignmentId", type: "bytes32" },
      { name: "worker", type: "address" },
      { name: "reservedPayout", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "specificationHash", type: "bytes32" },
      { name: "expectedEvidenceHash", type: "bytes32" },
      { name: "payoutRoot", type: "bytes32" },
      { name: "artifactId", type: "bytes32" },
      { name: "provenanceHash", type: "bytes32" },
      { name: "licenseHash", type: "bytes32" },
      { name: "moduleId", type: "bytes32" },
    ],
  };
  return Promise.all(
    validatorEntries.slice(0, 3).map((entry) =>
      entry.account.signTypedData({
        domain,
        types,
        primaryType: "TaskAdmission",
        message: task,
      }),
    ),
  );
}

const assignmentId = keccak256(toBytes("basic-assignment-1"));
const specificationHash = keccak256(toBytes("normalize-fixture-v1"));
const deliveryHash = keccak256(toBytes("artifact-content"));
const proof = toHex("deterministic runner passed 42 hidden checks");
const expectedEvidenceHash = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [specificationHash, deliveryHash, keccak256(proof)],
  ),
);
const recipients = [buyer, worker, planner];
const amounts = [parseEther("600"), parseEther("80"), parseEther("20")];
const task = {
  assignmentId,
  worker,
  reservedPayout: parseEther("700"),
  deadline: Number(blockTimestamp + 3_600n),
  specificationHash,
  expectedEvidenceHash,
  payoutRoot: payoutRoot(recipients, amounts),
  artifactId: zeroHash,
  provenanceHash: zeroHash,
  licenseHash: zeroHash,
  moduleId: zeroHash,
};
const signatures = await admissionSignatures(basicVault, task);
await write(
  "AgentPoolV41EpochVault",
  basicVault,
  "openAssignment",
  [
    task.assignmentId,
    task.worker,
    task.reservedPayout,
    task.deadline,
    task.specificationHash,
    task.expectedEvidenceHash,
    task.payoutRoot,
    task.artifactId,
    task.provenanceHash,
    task.licenseHash,
    task.moduleId,
    signatures,
  ],
);
check(
  "assignment reserves exactly its payout",
  await read(
    "AgentPoolV41EmissionController",
    controller,
    "vaultReserved",
    [basicVault],
  ),
  parseEther("700"),
);
await write("AgentPoolV41EpochVault", basicVault, "accept", [assignmentId], workerKey);
await write(
  "AgentPoolV41EpochVault",
  basicVault,
  "deliver",
  [assignmentId, deliveryHash],
  workerKey,
);
await write(
  "AgentPoolV41EpochVault",
  basicVault,
  "settle",
  [assignmentId, proof, recipients, amounts, zeroHash],
);
check(
  "objective settlement mints only the committed total",
  await read("AgentPoolV41Token", token, "totalSupply"),
  parseEther("700"),
);
check(
  "buyer receives its committed protocol-work payout",
  await read("AgentPoolV41Token", token, "balanceOf", [buyer]),
  parseEther("600"),
);
check(
  "reservation is consumed after settlement",
  await read(
    "AgentPoolV41EmissionController",
    controller,
    "vaultReserved",
    [basicVault],
  ),
  0n,
);
await expectRevert("duplicate settlement", () =>
  write(
    "AgentPoolV41EpochVault",
    basicVault,
    "settle",
    [assignmentId, proof, recipients, amounts, zeroHash],
  ),
);

const supplyBeforeExternal = await read(
  "AgentPoolV41Token",
  token,
  "totalSupply",
);
await write("AgentPoolV41Token", token, "approve", [userEscrow, parseEther("300")], buyerKey);
await write("AgentPoolV41Token", token, "approve", [userEscrow, parseEther("10")], workerKey);
const externalSpec = keccak256(toBytes("external-job"));
const externalDelivery = keccak256(toBytes("external-delivery"));
const externalProof = toHex("buyer-selected deterministic verifier passed");
const externalExpected = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [externalSpec, externalDelivery, keccak256(externalProof)],
  ),
);
const externalRecipients = [worker, planner];
const externalAmounts = [parseEther("260"), parseEther("40")];
const externalJobId = await read(
  "AgentPoolV41UserEscrow",
  userEscrow,
  "nextJobId",
);
await write(
  "AgentPoolV41UserEscrow",
  userEscrow,
  "fundJob",
  [
    worker,
    verifier,
    parseEther("300"),
    parseEther("10"),
    Number(blockTimestamp + 3_600n),
    externalSpec,
    externalExpected,
    externalRecipients,
    externalAmounts,
  ],
  buyerKey,
);
await write(
  "AgentPoolV41UserEscrow",
  userEscrow,
  "accept",
  [externalJobId],
  workerKey,
);
await write(
  "AgentPoolV41UserEscrow",
  userEscrow,
  "deliver",
  [externalJobId, externalDelivery],
  workerKey,
);
await write(
  "AgentPoolV41UserEscrow",
  userEscrow,
  "resolve",
  [externalJobId, externalProof, externalRecipients, externalAmounts],
);
check(
  "external settlement creates zero new tAPOOL",
  await read("AgentPoolV41Token", token, "totalSupply"),
  supplyBeforeExternal,
);
check(
  "external escrow fully conserves deposited funds",
  await read("AgentPoolV41Token", token, "balanceOf", [userEscrow]),
  0n,
);

const capabilityVault = await createVault({
  epoch: 0,
  lane: 0,
  salt: keccak256(toBytes("capability-vault")),
});
const epochAllowance = await read(
  "AgentPoolV41EmissionController",
  controller,
  "epochAllowance",
  [0],
);
const capabilityCap = epochAllowance * 500n / 10_000n;
const oversizedTask = {
  ...task,
  assignmentId: keccak256(toBytes("oversized-capability")),
  reservedPayout: capabilityCap + 1n,
  payoutRoot: payoutRoot([worker], [capabilityCap + 1n]),
  deadline: Number(blockTimestamp + 3_600n),
};
const oversizedSignatures = await admissionSignatures(
  capabilityVault,
  oversizedTask,
);
await expectRevert("capability lane cap", () =>
  write(
    "AgentPoolV41EpochVault",
    capabilityVault,
    "openAssignment",
    [
      oversizedTask.assignmentId,
      oversizedTask.worker,
      oversizedTask.reservedPayout,
      oversizedTask.deadline,
      oversizedTask.specificationHash,
      oversizedTask.expectedEvidenceHash,
      oversizedTask.payoutRoot,
      oversizedTask.artifactId,
      oversizedTask.provenanceHash,
      oversizedTask.licenseHash,
      oversizedTask.moduleId,
      oversizedSignatures,
    ],
  ),
);

const requiredContracts = [
  token,
  controller,
  verifier,
  userEscrow,
  releases,
  artifacts,
  basicVault,
  capabilityVault,
];
for (const address of requiredContracts) {
  const code = await vm.stateManager.getCode(createAddressFromString(address));
  assertCondition(code.length > 0 && code.length <= 24_576, `${address} code size invalid`);
}

const report = {
  version: "4.1.0-alpha",
  chainId: 31337,
  transactionCount,
  gasSpent: gasSpent.toString(),
  contracts: {
    token,
    controller,
    verifier,
    userEscrow,
    releases,
    artifacts,
    basicVault,
    capabilityVault,
  },
  checks,
  passed: checks.every((entry) => entry.passed),
};
const output = path.join(root, "outputs", "v41-local-rehearsal.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({
    ok: report.passed,
    checks: checks.length,
    transactionCount,
    output,
  })}\n`,
);

