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
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";

const root = process.cwd();
const outputDirectory = path.join(root, "outputs");
const deploymentDirectory = path.join(outputDirectory, "deployments");
fs.mkdirSync(deploymentDirectory, { recursive: true });

const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool Local Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("Failed to configure the local EVM");
const vm = await createVM({ common, activatePrecompiles: true });

// Hardhat's documented deterministic test key. It is used only in this
// in-memory EVM and is never accepted by the public deployment script.
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
const roleKeys = {
  operator: rehearsalKey(2),
  ecosystem: rehearsalKey(3),
  liquidity: rehearsalKey(4),
  security: rehearsalKey(5),
  evaluator: rehearsalKey(6),
  publisher: rehearsalKey(7),
};
const roles = Object.fromEntries(
  Object.entries(roleKeys).map(([name, key]) => [name, addressFor(key)]),
);
const verifierKey = rehearsalKey(8);
const verifierAdapter = addressFor(verifierKey);
const evaluatorKeys = Array.from({ length: 5 }, (_, index) => rehearsalKey(index + 9));
const evaluators = evaluatorKeys.map(addressFor);
const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const verifierNames = protocolConfig.bootstrapVerifierNames;
const verifierIds = verifierNames.map((name) => keccak256(toBytes(name)));
const verifierId = verifierIds[0];
const verifierImplementationHash = keccak256(
  toBytes("agentpool.rehearsal.verifier.implementation.v1"),
);
const roleAddresses = [...Object.values(roles), verifierAdapter, ...evaluators];
if (new Set(roleAddresses.map((address) => address.toLowerCase())).size !== roleAddresses.length) {
  throw new Error("Rehearsal roles must be distinct");
}
if (roleAddresses.some((address) => address.toLowerCase() === deployerAddress.toLowerCase())) {
  throw new Error("The rehearsal deployer must not hold an operating role");
}
for (const key of [privateKey, ...Object.values(roleKeys), verifierKey, ...evaluatorKeys]) {
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

const signerNonces = new Map();
let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
let transactionCount = 0;
let gasSpent = 0n;
function advanceTime(seconds) {
  blockTimestamp += BigInt(seconds);
}
async function execute(data, to, signingKey = privateKey) {
  const signerAddress = addressFor(signingKey).toLowerCase();
  const nonce = signerNonces.get(signerAddress) ?? 0n;
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
  if (result.execResult.exceptionError) {
    const returnData = bytesToHex(result.execResult.returnValue);
    throw new Error(
      `Local EVM transaction ${nonce} reverted: ${result.execResult.exceptionError.error}; data=${returnData}`,
    );
  }
  signerNonces.set(signerAddress, nonce + 1n);
  blockNumber += 1n;
  blockTimestamp += 1n;
  transactionCount += 1;
  gasSpent += result.totalGasSpent;
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
  if (!result.createdAddress) throw new Error(`${name} did not return a contract address`);
  const address = getAddress(result.createdAddress.toString());
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0) throw new Error(`${name} has no deployed bytecode`);
  console.log(`${name}: ${address}`);
  return address;
}

async function write(name, address, functionName, args = [], signingKey = privateKey) {
  return execute(
    encodeFunctionData({
      abi: artifact(name).abi,
      functionName,
      args,
    }),
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
      encodeFunctionData({
        abi: artifact(name).abi,
        functionName,
        args,
      }),
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

const schedulePath = path.join(root, "mining-schedule.json");
const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
if (schedule.budgetsWei.length !== 520) {
  throw new Error(`Mining schedule has ${schedule.budgetsWei.length} epochs; expected 520`);
}
const scheduledBudget = schedule.budgetsWei.reduce(
  (total, value) => total + BigInt(value),
  0n,
);
if (scheduledBudget !== parseEther("500000000")) {
  throw new Error(`Mining schedule total is ${scheduledBudget}; expected 500M APOOL`);
}
console.log("Preflight OK: 520 epochs and 500M APOOL mining budget");

const genesis = blockTimestamp;
const siteUrl = "https://agentpool-protocol.asfu.chatgpt.site";
const token = await deploy("AgentPoolToken", [
  deployerAddress,
  roles.operator,
  roles.ecosystem,
  roles.liquidity,
  roles.security,
]);
const timelock = await deploy("TimelockController", [
  7n * 24n * 60n * 60n,
  [deployerAddress],
  [zeroAddress],
  deployerAddress,
]);
const governor = await deploy("AgentPoolGovernor", [token, timelock]);
const registry = await deploy("AgentPoolRegistry", [deployerAddress]);
const license = await deploy("AgentPoolLicense", [
  `${siteUrl}/api/v1/licenses/{id}.json`,
]);
const randomnessProvider = await deploy("MockRandomnessProvider", [deployerAddress]);
const oracle = await deploy("AgentPoolWorkOracle", [
  deployerAddress,
  registry,
  randomnessProvider,
  roles.evaluator,
]);
const escrow = await deploy("AgentPoolJobEscrow", [
  token,
  registry,
  deployerAddress,
  roles.security,
]);
const miningVault = await deploy("AgentPoolMiningVault", [
  token,
  deployerAddress,
  roles.publisher,
  genesis,
]);

await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
for (const configuredVerifierId of verifierIds) {
  await write("AgentPoolRegistry", registry, "configureVerifier", [
    configuredVerifierId,
    verifierAdapter,
    verifierImplementationHash,
    true,
    true,
  ]);
}
for (const evaluator of evaluators) {
  await write("AgentPoolWorkOracle", oracle, "setEvaluator", [evaluator, true]);
}
await write("AgentPoolWorkOracle", oracle, "setEscrow", [escrow]);
await write("AgentPoolJobEscrow", escrow, "setResolver", [oracle]);

for (let start = 0; start < schedule.budgetsWei.length; start += 20) {
  await write("AgentPoolMiningVault", miningVault, "configureEpochs", [
    start,
    schedule.budgetsWei.slice(start, start + 20).map(BigInt),
  ]);
}
await write("AgentPoolToken", token, "transfer", [
  miningVault,
  parseEther("500000000"),
]);

for (const [name, address] of [
  ["AgentPoolRegistry", registry],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
  ["MockRandomnessProvider", randomnessProvider],
]) {
  await write(name, address, "transferOwnership", [timelock]);
}

const proposerRole = keccak256(toBytes("PROPOSER_ROLE"));
const cancellerRole = keccak256(toBytes("CANCELLER_ROLE"));
await write("TimelockController", timelock, "grantRole", [proposerRole, governor]);
await write("TimelockController", timelock, "grantRole", [cancellerRole, governor]);
await write("TimelockController", timelock, "revokeRole", [proposerRole, deployerAddress]);
await write("TimelockController", timelock, "revokeRole", [cancellerRole, deployerAddress]);
await write("TimelockController", timelock, "revokeRole", [zeroHash, deployerAddress]);

const scenarioChecks = [];
function scenarioCheck(name, actual, expected) {
  const normalizedActual = typeof actual === "bigint" ? actual.toString() : actual;
  const normalizedExpected = typeof expected === "bigint" ? expected.toString() : expected;
  scenarioChecks.push({
    name,
    passed: normalizedActual === normalizedExpected,
    actual: normalizedActual,
    expected: normalizedExpected,
  });
}
async function tokenBalance(address) {
  return read("AgentPoolToken", token, "balanceOf", [address]);
}
async function approveEscrow(signingKey, amount) {
  await write("AgentPoolToken", token, "approve", [escrow, amount], signingKey);
}

await vm.stateManager.checkpoint();
try {
  const successPrice = parseEther("300");
  const successEvaluation = parseEther("10");
  const successBond = parseEther("30");
  const successBuyerStart = await tokenBalance(roles.operator);
  const successSellerStart = await tokenBalance(roles.ecosystem);
  const successEvaluatorStart = await tokenBalance(roles.evaluator);
  const successSecurityStart = await tokenBalance(roles.security);
  const successJobId = await read("AgentPoolJobEscrow", escrow, "nextJobId");
  await approveEscrow(roleKeys.operator, successPrice + successEvaluation);
  await approveEscrow(roleKeys.ecosystem, successBond);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "fundJob",
    [
      roles.ecosystem,
      successPrice,
      successEvaluation,
      successBond,
      blockTimestamp + 3_600n,
      keccak256(toBytes("success requirements")),
      verifierId,
    ],
    roleKeys.operator,
  );
  await write("AgentPoolJobEscrow", escrow, "acceptJob", [successJobId], roleKeys.ecosystem);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "submitJob",
    [successJobId, keccak256(toBytes("success delivery"))],
    roleKeys.ecosystem,
  );
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "proposeOutcome",
    [successJobId, verifierId, 0],
    verifierKey,
  );
  advanceTime(2 * 60 * 60 + 1);
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "finalizeUnchallenged",
    [successJobId],
    roleKeys.operator,
  );
  scenarioCheck(
    "lifecycle.success.state",
    await read("AgentPoolJobEscrow", escrow, "jobState", [successJobId]),
    6,
  );
  scenarioCheck(
    "lifecycle.success.buyerDelta",
    (await tokenBalance(roles.operator)) - successBuyerStart,
    -(successPrice + successEvaluation),
  );
  scenarioCheck(
    "lifecycle.success.sellerReceivesFullPrice",
    (await tokenBalance(roles.ecosystem)) - successSellerStart,
    successPrice,
  );
  scenarioCheck(
    "lifecycle.success.evaluatorShare",
    (await tokenBalance(roles.evaluator)) - successEvaluatorStart,
    successEvaluation * 9n / 10n,
  );
  scenarioCheck(
    "lifecycle.success.securityShare",
    (await tokenBalance(roles.security)) - successSecurityStart,
    successEvaluation / 10n,
  );
  scenarioCheck("lifecycle.success.escrowCleared", await tokenBalance(escrow), 0n);

  const expiryPrice = parseEther("100");
  const expiryEvaluation = parseEther("5");
  const expiryBond = parseEther("25");
  const expiryBuyerStart = await tokenBalance(roles.operator);
  const expirySellerStart = await tokenBalance(roles.ecosystem);
  const expirySecurityStart = await tokenBalance(roles.security);
  const expiryJobId = await read("AgentPoolJobEscrow", escrow, "nextJobId");
  await approveEscrow(roleKeys.operator, expiryPrice + expiryEvaluation);
  await approveEscrow(roleKeys.ecosystem, expiryBond);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "fundJob",
    [
      roles.ecosystem,
      expiryPrice,
      expiryEvaluation,
      expiryBond,
      blockTimestamp + 120n,
      keccak256(toBytes("expiry requirements")),
      verifierId,
    ],
    roleKeys.operator,
  );
  await write("AgentPoolJobEscrow", escrow, "acceptJob", [expiryJobId], roleKeys.ecosystem);
  advanceTime(121);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "refundExpired",
    [expiryJobId],
    roleKeys.operator,
  );
  scenarioCheck(
    "lifecycle.expiry.state",
    await read("AgentPoolJobEscrow", escrow, "jobState", [expiryJobId]),
    9,
  );
  scenarioCheck(
    "lifecycle.expiry.buyerRefunded",
    (await tokenBalance(roles.operator)) - expiryBuyerStart,
    0n,
  );
  scenarioCheck(
    "lifecycle.expiry.sellerBondSlashed",
    (await tokenBalance(roles.ecosystem)) - expirySellerStart,
    -expiryBond,
  );
  scenarioCheck(
    "lifecycle.expiry.securityReceivesBond",
    (await tokenBalance(roles.security)) - expirySecurityStart,
    expiryBond,
  );
  scenarioCheck("lifecycle.expiry.escrowCleared", await tokenBalance(escrow), 0n);

  const disputePrice = parseEther("200");
  const disputeEvaluation = parseEther("10");
  const disputeBond = parseEther("20");
  const disputeBuyerStart = await tokenBalance(roles.operator);
  const disputeSellerStart = await tokenBalance(roles.ecosystem);
  const disputeEvaluatorStart = await tokenBalance(roles.evaluator);
  const disputeSecurityStart = await tokenBalance(roles.security);
  const disputeJobId = await read("AgentPoolJobEscrow", escrow, "nextJobId");
  const disputeId = await read("AgentPoolWorkOracle", oracle, "nextDisputeId");
  const requestId = await read(
    "MockRandomnessProvider",
    randomnessProvider,
    "nextRequestId",
  );
  await approveEscrow(roleKeys.operator, disputePrice + disputeEvaluation);
  await approveEscrow(roleKeys.ecosystem, disputeBond);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "fundJob",
    [
      roles.ecosystem,
      disputePrice,
      disputeEvaluation,
      disputeBond,
      blockTimestamp + 3_600n,
      keccak256(toBytes("dispute requirements")),
      verifierId,
    ],
    roleKeys.operator,
  );
  await write("AgentPoolJobEscrow", escrow, "acceptJob", [disputeJobId], roleKeys.ecosystem);
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "submitJob",
    [disputeJobId, keccak256(toBytes("dispute delivery"))],
    roleKeys.ecosystem,
  );
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "proposeOutcome",
    [disputeJobId, verifierId, 0],
    verifierKey,
  );
  await write(
    "AgentPoolJobEscrow",
    escrow,
    "challenge",
    [disputeJobId],
    roleKeys.operator,
  );
  await write(
    "MockRandomnessProvider",
    randomnessProvider,
    "fulfill",
    [requestId, 123456789n],
    roleKeys.operator,
  );
  const selectedEvaluators = [];
  for (let index = 0; index < 5; index += 1) {
    selectedEvaluators.push(
      await read("AgentPoolWorkOracle", oracle, "selectedEvaluators", [
        disputeId,
        index,
      ]),
    );
  }
  scenarioCheck(
    "lifecycle.dispute.uniquePanel",
    new Set(selectedEvaluators.map((address) => address.toLowerCase())).size,
    5,
  );
  scenarioCheck(
    "lifecycle.dispute.authorizedPanel",
    selectedEvaluators.every((address) =>
      evaluators.some((evaluator) => evaluator.toLowerCase() === address.toLowerCase()),
    ),
    true,
  );
  advanceTime(2 * 60 * 60 + 1);
  await write(
    "AgentPoolWorkOracle",
    oracle,
    "finalize",
    [disputeId],
    roleKeys.operator,
  );
  scenarioCheck(
    "lifecycle.dispute.ambiguousState",
    await read("AgentPoolJobEscrow", escrow, "jobState", [disputeJobId]),
    8,
  );
  scenarioCheck(
    "lifecycle.dispute.buyerRefundMinusEvaluation",
    (await tokenBalance(roles.operator)) - disputeBuyerStart,
    -disputeEvaluation,
  );
  scenarioCheck(
    "lifecycle.dispute.sellerBondSlashed",
    (await tokenBalance(roles.ecosystem)) - disputeSellerStart,
    -disputeBond,
  );
  scenarioCheck(
    "lifecycle.dispute.evaluatorShare",
    (await tokenBalance(roles.evaluator)) - disputeEvaluatorStart,
    disputeEvaluation * 9n / 10n,
  );
  scenarioCheck(
    "lifecycle.dispute.securityReceivesShareAndBond",
    (await tokenBalance(roles.security)) - disputeSecurityStart,
    disputeEvaluation / 10n + disputeBond,
  );
  scenarioCheck("lifecycle.dispute.escrowCleared", await tokenBalance(escrow), 0n);

  const serviceCreditId = await read("AgentPoolLicense", license, "tokenIdFor", [
    roles.ecosystem,
    1n,
  ]);
  await write(
    "AgentPoolLicense",
    license,
    "defineLicense",
    [1n, keccak256(toBytes("one future module delivery")), false],
    roleKeys.ecosystem,
  );
  await write(
    "AgentPoolLicense",
    license,
    "issue",
    [roles.operator, serviceCreditId, 2n, "0x"],
    roleKeys.ecosystem,
  );
  await write(
    "AgentPoolLicense",
    license,
    "redeem",
    [serviceCreditId, 1n, keccak256(toBytes("module redemption request"))],
    roleKeys.operator,
  );
  scenarioCheck(
    "serviceCredit.issuer",
    await read("AgentPoolLicense", license, "issuer", [serviceCreditId]),
    roles.ecosystem,
  );
  scenarioCheck(
    "serviceCredit.balance",
    await read("AgentPoolLicense", license, "balanceOf", [
      roles.operator,
      serviceCreditId,
    ]),
    1n,
  );
} finally {
  await vm.stateManager.revert();
}

const contracts = {
  token,
  timelock,
  governor,
  registry,
  license,
  randomnessProvider,
  oracle,
  escrow,
  miningVault,
};
const manifestPath = path.join(deploymentDirectory, "31337.json");
const manifest = {
  version: 1,
  chainId: 31337,
  network: "AgentPool Local Rehearsal",
  engine: "@ethereumjs/vm",
  hardfork: Hardfork.Cancun,
  deployer: deployerAddress,
  deployedAt: new Date().toISOString(),
  contracts,
  bootstrap: {
    verifiers: verifierNames.map((name, index) => ({
      name,
      id: verifierIds[index],
    })),
    verifierAdapter,
    verifierImplementationHash,
    evaluators,
  },
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const checks = [];
function check(name, actual, expected) {
  const normalize = (value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase();
    return value;
  };
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  checks.push({
    name,
    passed: normalizedActual === normalizedExpected,
    actual: normalizedActual,
    expected: normalizedExpected,
  });
}
checks.push(...scenarioChecks);

const codeHashes = {};
for (const [name, address] of Object.entries(contracts)) {
  const code = await vm.stateManager.getCode(createAddressFromString(address));
  check(`bytecode:${name}`, code.length > 0, true);
  if (code.length > 0) codeHashes[name] = keccak256(bytesToHex(code));
}
check("token.totalSupply", await read("AgentPoolToken", token, "totalSupply"), parseEther("1000000000"));
check(
  "token.operatorAllocation",
  await read("AgentPoolToken", token, "balanceOf", [roles.operator]),
  parseEther("200000000"),
);
check(
  "token.miningVaultAllocation",
  await read("AgentPoolToken", token, "balanceOf", [miningVault]),
  parseEther("500000000"),
);
check(
  "escrow.permanentProtocolFeeBps",
  await read("AgentPoolJobEscrow", escrow, "PROTOCOL_FEE_BPS"),
  0,
);
check(
  "escrow.noFeeSetter",
  artifact("AgentPoolJobEscrow").abi.some((entry) => entry.name === "setProtocolFee"),
  false,
);
check("escrow.resolver", await read("AgentPoolJobEscrow", escrow, "resolver"), oracle);
check("escrow.registry", await read("AgentPoolJobEscrow", escrow, "registry"), registry);
check("oracle.escrow", await read("AgentPoolWorkOracle", oracle, "escrow"), escrow);
check("oracle.registry", await read("AgentPoolWorkOracle", oracle, "registry"), registry);
for (const [index, configuredVerifierId] of verifierIds.entries()) {
  check(
    `registry.verifier${index + 1}Active`,
    await read("AgentPoolRegistry", registry, "isActiveVerifier", [
      configuredVerifierId,
    ]),
    true,
  );
  check(
    `registry.verifier${index + 1}Authorized`,
    await read("AgentPoolRegistry", registry, "isAuthorizedVerifier", [
      configuredVerifierId,
      verifierAdapter,
    ]),
    true,
  );
  check(
    `registry.verifier${index + 1}MiningEligible`,
    await read("AgentPoolRegistry", registry, "isMiningVerifier", [
      configuredVerifierId,
    ]),
    true,
  );
}
for (const [index, evaluator] of evaluators.entries()) {
  check(
    `oracle.evaluator${index + 1}Eligible`,
    await read("AgentPoolWorkOracle", oracle, "isEligible", [evaluator]),
    true,
  );
}
check(
  "mining.configuredBudget",
  await read("AgentPoolMiningVault", miningVault, "configuredBudget"),
  parseEther("500000000"),
);
check(
  "timelock.minDelay",
  await read("TimelockController", timelock, "getMinDelay"),
  7n * 24n * 60n * 60n,
);
check(
  "governor.quorumNumerator",
  await read("AgentPoolGovernor", governor, "quorumNumerator"),
  25n,
);
check(
  "governor.proposalThreshold",
  await read("AgentPoolGovernor", governor, "proposalThreshold"),
  parseEther("10000000"),
);
check(
  "governor.votingPeriod",
  await read("AgentPoolGovernor", governor, "votingPeriod"),
  302400n,
);

for (const [name, address] of [
  ["AgentPoolRegistry", registry],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
  ["MockRandomnessProvider", randomnessProvider],
]) {
  check(`owner:${name}`, await read(name, address, "owner"), timelock);
}
check(
  "timelock.governorProposer",
  await read("TimelockController", timelock, "hasRole", [proposerRole, governor]),
  true,
);
check(
  "timelock.governorCanceller",
  await read("TimelockController", timelock, "hasRole", [cancellerRole, governor]),
  true,
);
for (const [label, role] of [
  ["admin", zeroHash],
  ["proposer", proposerRole],
  ["canceller", cancellerRole],
]) {
  check(
    `deployerRoleRemoved:${label}`,
    await read("TimelockController", timelock, "hasRole", [role, deployerAddress]),
    false,
  );
}
check(
  "mockRandomness.consumer",
  await read("MockRandomnessProvider", randomnessProvider, "consumer"),
  oracle,
);

const failures = checks.filter((entry) => !entry.passed);
const evidencePath = path.join(outputDirectory, "deployment-verification-31337.json");
fs.writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      version: 1,
      verifiedAt: new Date().toISOString(),
      chainId: 31337,
      network: "AgentPool Local Rehearsal",
      engine: "@ethereumjs/vm",
      hardfork: Hardfork.Cancun,
      transactionCount,
      gasSpent: gasSpent.toString(),
      manifest,
      codeHashes,
      checks,
      status: failures.length === 0 ? "passed" : "failed",
    },
    null,
    2,
  )}\n`,
);
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} local deployment verification checks failed`);
}
console.log(
  `Deployment verification passed (${checks.length} checks, ${transactionCount} transactions): ${evidencePath}`,
);
console.log("AGENTPOOL_LOCAL_REHEARSAL_OK");
