import fs from "node:fs";
import path from "node:path";
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
await vm.stateManager.putAccount(
  deployer,
  createAccount({ nonce: 0n, balance: parseEther("10000") }),
);

const roles = {
  operator: getAddress("0x1000000000000000000000000000000000000001"),
  ecosystem: getAddress("0x1000000000000000000000000000000000000002"),
  liquidity: getAddress("0x1000000000000000000000000000000000000003"),
  security: getAddress("0x1000000000000000000000000000000000000004"),
  protocol: getAddress("0x1000000000000000000000000000000000000005"),
  evaluator: getAddress("0x1000000000000000000000000000000000000006"),
  publisher: getAddress("0x1000000000000000000000000000000000000007"),
};
const roleAddresses = Object.values(roles);
if (new Set(roleAddresses.map((address) => address.toLowerCase())).size !== roleAddresses.length) {
  throw new Error("Rehearsal roles must be distinct");
}
if (roleAddresses.some((address) => address.toLowerCase() === deployerAddress.toLowerCase())) {
  throw new Error("The rehearsal deployer must not hold an operating role");
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

let nonce = 0n;
let transactionCount = 0;
let gasSpent = 0n;
async function execute(data, to) {
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
  ).sign(privateKey);
  const result = await runTx(vm, {
    tx,
    skipBlockGasLimitValidation: true,
  });
  if (result.execResult.exceptionError) {
    const returnData = bytesToHex(result.execResult.returnValue);
    throw new Error(
      `Local EVM transaction ${nonce} reverted: ${result.execResult.exceptionError.error}; data=${returnData}`,
    );
  }
  nonce += 1n;
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

async function write(name, address, functionName, args = []) {
  return execute(
    encodeFunctionData({
      abi: artifact(name).abi,
      functionName,
      args,
    }),
    address,
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

const genesis = BigInt(Math.floor(Date.now() / 1000));
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
  deployerAddress,
  `${siteUrl}/api/v1/licenses/{id}.json`,
]);
const randomnessProvider = await deploy("MockRandomnessProvider");
const oracle = await deploy("AgentPoolWorkOracle", [
  deployerAddress,
  randomnessProvider,
  roles.evaluator,
]);
const escrow = await deploy("AgentPoolJobEscrow", [
  token,
  deployerAddress,
  roles.protocol,
  roles.security,
]);
const miningVault = await deploy("AgentPoolMiningVault", [
  token,
  deployerAddress,
  roles.publisher,
  genesis,
]);

await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
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
  ["AgentPoolLicense", license],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
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
check("escrow.protocolFeeBps", await read("AgentPoolJobEscrow", escrow, "protocolFeeBps"), 0);
check(
  "escrow.maxProtocolFeeBps",
  await read("AgentPoolJobEscrow", escrow, "MAX_PROTOCOL_FEE_BPS"),
  25,
);
check("escrow.resolver", await read("AgentPoolJobEscrow", escrow, "resolver"), oracle);
check("oracle.escrow", await read("AgentPoolWorkOracle", oracle, "escrow"), escrow);
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
  ["AgentPoolLicense", license],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", escrow],
  ["AgentPoolMiningVault", miningVault],
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
