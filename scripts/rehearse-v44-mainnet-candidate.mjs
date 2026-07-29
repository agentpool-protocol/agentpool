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
} from "viem";
import {
  ROOT,
  ZERO_ADDRESS,
  loadAndValidateConfig,
} from "./lib/v44-mainnet.mjs";

const config = loadAndValidateConfig().config;
const common = createCustomCommon(
  { chainId: 8453, name: "AgentPool v4.4 Mainnet Candidate Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("V44_LOCAL_EVM_COMMON_FAILED");
const vm = await createVM({ common, activatePrecompiles: true });

function keyFor(index) {
  return hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
}
function addressFor(key) {
  return getAddress(createAddressFromPrivateKey(key).toString());
}

const deployerKey = keyFor(101);
const attackerKey = keyFor(102);
const workerKey = keyFor(103);
const deployer = addressFor(deployerKey);
const attacker = addressFor(attackerKey);
const worker = addressFor(workerKey);
for (const key of [deployerKey, attackerKey, workerKey]) {
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(key),
    createAccount({ nonce: 0n, balance: parseEther("100") }),
  );
}

const artifactCache = new Map();
function artifact(name) {
  if (!artifactCache.has(name)) {
    artifactCache.set(
      name,
      JSON.parse(
        fs.readFileSync(path.join(ROOT, "artifacts", `${name}.json`), "utf8"),
      ),
    );
  }
  return artifactCache.get(name);
}

let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1_000));
let transactionCount = 0;
let gasSpent = 0n;
const checks = [];
let randomState = 0x44a91c3d;

function randomBelow(exclusiveMaximum) {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  randomState >>>= 0;
  return randomState % exclusiveMaximum;
}

function wholeApool(value) {
  return parseEther(String(value));
}

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
  blockNumber += 1n;
  blockTimestamp += 1n;
  transactionCount += 1;
  gasSpent += result.totalGasSpent;
  if (result.execResult.exceptionError) {
    throw new Error(
      `V44_LOCAL_EVM_REVERT:${result.execResult.exceptionError.error}:${bytesToHex(result.execResult.returnValue)}`,
    );
  }
  return result;
}

async function deploy(name, args = [], key = deployerKey) {
  const compiled = artifact(name);
  const result = await execute(
    encodeDeployData({
      abi: compiled.abi,
      bytecode: compiled.bytecode,
      args,
    }),
    undefined,
    key,
  );
  if (!result.createdAddress) throw new Error(`${name}_DEPLOYMENT_FAILED`);
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0 || code.length > 24_576) {
    throw new Error(`${name}_INVALID_CODE_SIZE:${code.length}`);
  }
  return getAddress(result.createdAddress.toString());
}

async function write(
  name,
  address,
  functionName,
  args = [],
  key = deployerKey,
) {
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
    checks.push({
      name,
      passed: true,
      actual: "reverted",
      expected: "reverted",
    });
    return;
  }
  throw new Error(`${name}_UNEXPECTEDLY_SUCCEEDED`);
}

const genesisStart = Number(blockTimestamp + 120n);
const token = await deploy("AgentPoolV44Token", [deployer]);
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
const harness = await deploy("AgentPoolV44EpochVaultHarness");
const userEscrow = await deploy("AgentPoolV43UserEscrowKernel", [
  token,
  deployer,
]);

check(
  "token.initialSupplyZero",
  await read("AgentPoolV44Token", token, "totalSupply"),
  0n,
);
check("token.name", await read("AgentPoolV44Token", token, "name"), "AgentPool");
check("token.symbol", await read("AgentPoolV44Token", token, "symbol"), "APOOL");
check(
  "token.decimals",
  await read("AgentPoolV44Token", token, "decimals"),
  18,
);
check(
  "token.maxSupply",
  await read("AgentPoolV44Token", token, "MAX_SUPPLY"),
  parseEther(config.token.maxSupplyApool),
);
await expectRevert("token.attackerCannotConfigureMinters", () =>
  write(
    "AgentPoolV44Token",
    token,
    "configureMinters",
    [coreVault, evolutionVault],
    attackerKey,
  ),
);
await expectRevert("token.rejectsEoaMinter", () =>
  write(
    "AgentPoolV44Token",
    token,
    "configureMinters",
    [attacker, evolutionVault],
  ),
);
await write(
  "AgentPoolV44Token",
  token,
  "configureMinters",
  [coreVault, evolutionVault],
);
check(
  "token.configurationAuthorityRemoved",
  await read("AgentPoolV44Token", token, "configurationAuthority"),
  ZERO_ADDRESS,
);
check(
  "token.coreMinter",
  await read("AgentPoolV44Token", token, "coreEpochVault"),
  coreVault,
);
check(
  "token.evolutionMinter",
  await read("AgentPoolV44Token", token, "evolutionEpochVault"),
  evolutionVault,
);
await expectRevert("token.cannotReconfigureMinters", () =>
  write(
    "AgentPoolV44Token",
    token,
    "configureMinters",
    [evolutionVault, coreVault],
  ),
);
await expectRevert("token.deployerCannotMint", () =>
  write("AgentPoolV44Token", token, "mint", [worker, parseEther("1")]),
);
await expectRevert("token.arbitraryContractCannotMint", () =>
  write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "attemptDirectMint",
    [token, worker, parseEther("1")],
  ),
);

for (const vault of [coreVault, evolutionVault]) {
  await write(
    "AgentPoolV43EpochVault",
    vault,
    "configureMarket",
    [harness],
  );
  check(
    `vault.${vault}.configurationAuthorityRemoved`,
    await read("AgentPoolV43EpochVault", vault, "configurationAuthority"),
    ZERO_ADDRESS,
  );
}
await write(
  "AgentPoolV43UserEscrowKernel",
  userEscrow,
  "configureMarket",
  [harness],
);
check(
  "escrow.configurationAuthorityRemoved",
  await read(
    "AgentPoolV43UserEscrowKernel",
    userEscrow,
    "configurationAuthority",
  ),
  ZERO_ADDRESS,
);

const coreReservation = keccak256(toBytes("v44-core-reservation"));
await expectRevert("vault.emissionCannotReserveBeforeGenesis", () =>
  write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "reserve",
    [coreVault, coreReservation, parseEther("100")],
  ),
);
check(
  "token.supplyRemainsZeroBeforeGenesis",
  await read("AgentPoolV44Token", token, "totalSupply"),
  0n,
);
blockTimestamp = BigInt(genesisStart + 1);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [coreVault, coreReservation, parseEther("100")],
);
await expectRevert("coreVault.duplicateReservationRejected", () =>
  write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "reserve",
    [coreVault, coreReservation, parseEther("1")],
  ),
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "settle",
  [coreVault, coreReservation, [worker], [parseEther("80")]],
);
check(
  "coreVault.workerPaid",
  await read("AgentPoolV44Token", token, "balanceOf", [worker]),
  parseEther("80"),
);
check(
  "coreVault.totalEmitted",
  await read("AgentPoolV43EpochVault", coreVault, "totalEmitted"),
  parseEther("80"),
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "release",
  [coreVault, coreReservation],
);
check(
  "coreVault.unusedReservationNotMinted",
  await read("AgentPoolV44Token", token, "totalSupply"),
  parseEther("80"),
);

const evolutionReservation = keccak256(
  toBytes("v44-evolution-reservation"),
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [evolutionVault, evolutionReservation, parseEther("50")],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "settle",
  [evolutionVault, evolutionReservation, [worker], [parseEther("50")]],
);
check(
  "token.supplyEqualsBothVaultEmissions",
  await read("AgentPoolV44Token", token, "totalSupply"),
  (await read("AgentPoolV43EpochVault", coreVault, "totalEmitted")) +
    (await read(
      "AgentPoolV43EpochVault",
      evolutionVault,
      "totalEmitted",
    )),
);

let expectedCoreEmission = 80n;
const statefulCases = 32;
for (let caseIndex = 0; caseIndex < statefulCases; caseIndex++) {
  const reserved = BigInt(1 + randomBelow(100));
  const settled = BigInt(randomBelow(Number(reserved) + 1));
  const reservationId = keccak256(
    toBytes(`v44-stateful-${caseIndex}-${reserved}-${settled}`),
  );
  await write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "reserve",
    [coreVault, reservationId, wholeApool(reserved)],
  );
  if (settled != 0n) {
    const first =
      settled === 1n
        ? 1n
        : BigInt(1 + randomBelow(Number(settled)));
    await write(
      "AgentPoolV44EpochVaultHarness",
      harness,
      "settle",
      [coreVault, reservationId, [worker], [wholeApool(first)]],
    );
    if (first < settled) {
      await write(
        "AgentPoolV44EpochVaultHarness",
        harness,
        "settle",
        [
          coreVault,
          reservationId,
          [worker],
          [wholeApool(settled - first)],
        ],
      );
    }
    expectedCoreEmission += settled;
  }
  await write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "release",
    [coreVault, reservationId],
  );
  check(
    `stateful.${caseIndex}.reservationConserved`,
    await read("AgentPoolV43EpochVault", coreVault, "totalReserved"),
    0n,
  );
  check(
    `stateful.${caseIndex}.emissionConserved`,
    await read("AgentPoolV43EpochVault", coreVault, "totalEmitted"),
    wholeApool(expectedCoreEmission),
  );
  check(
    `stateful.${caseIndex}.supplyConserved`,
    await read("AgentPoolV44Token", token, "totalSupply"),
    wholeApool(expectedCoreEmission + 50n),
  );
}

const coreWeeklyCap = BigInt(config.emission.coreWeeklyCapApool);
const firstEpochRemainder = coreWeeklyCap - expectedCoreEmission;
const exactCapReservation = keccak256(toBytes("v44-exact-weekly-cap"));
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [coreVault, exactCapReservation, wholeApool(firstEpochRemainder)],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "settle",
  [coreVault, exactCapReservation, [worker], [wholeApool(firstEpochRemainder)]],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "release",
  [coreVault, exactCapReservation],
);
expectedCoreEmission = coreWeeklyCap;
check(
  "coreVault.firstEpochReachedExactCap",
  await read("AgentPoolV43EpochVault", coreVault, "epochEmitted", [0n]),
  wholeApool(coreWeeklyCap),
);
await expectRevert("coreVault.weeklyCapCannotBeExceeded", () =>
  write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "reserve",
    [
      coreVault,
      keccak256(toBytes("v44-over-cap")),
      parseEther(config.emission.coreWeeklyCapApool),
    ],
  ),
);
await expectRevert("vault.attackerCannotReserveDirectly", () =>
  write(
    "AgentPoolV43EpochVault",
    coreVault,
    "reserve",
    [keccak256(toBytes("v44-attacker")), parseEther("1")],
    attackerKey,
  ),
);

blockTimestamp = BigInt(genesisStart + 604_800 + 1);
const nextEpochReservation = keccak256(toBytes("v44-next-epoch"));
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [coreVault, nextEpochReservation, wholeApool(7)],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "settle",
  [coreVault, nextEpochReservation, [worker], [wholeApool(3)]],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "release",
  [coreVault, nextEpochReservation],
);
expectedCoreEmission += 3n;
check(
  "coreVault.nextEpochHasIndependentBudget",
  await read("AgentPoolV43EpochVault", coreVault, "epochEmitted", [1n]),
  wholeApool(3),
);
check(
  "token.supplyStillEqualsVaultEmissionsAfterEpochRollover",
  await read("AgentPoolV44Token", token, "totalSupply"),
  (await read("AgentPoolV43EpochVault", coreVault, "totalEmitted")) +
    (await read(
      "AgentPoolV43EpochVault",
      evolutionVault,
      "totalEmitted",
    )),
);

const lifetimeGenesis = Number(blockTimestamp + 10n);
const lifetimeVault = await deploy("AgentPoolV43EpochVault", [
  token,
  keccak256(toBytes("LIFETIME_INVARIANT")),
  lifetimeGenesis,
  wholeApool(100),
  wholeApool(150),
  deployer,
]);
await write(
  "AgentPoolV43EpochVault",
  lifetimeVault,
  "configureMarket",
  [harness],
);
blockTimestamp = BigInt(lifetimeGenesis + 1);
const lifetimeFirst = keccak256(toBytes("v44-lifetime-first"));
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [lifetimeVault, lifetimeFirst, wholeApool(100)],
);
blockTimestamp += 604_800n;
await expectRevert("vault.lifetimeCapCountsOpenPriorEpochReservations", () =>
  write(
    "AgentPoolV44EpochVaultHarness",
    harness,
    "reserve",
    [
      lifetimeVault,
      keccak256(toBytes("v44-lifetime-over")),
      wholeApool(51),
    ],
  ),
);
const lifetimeSecond = keccak256(toBytes("v44-lifetime-second"));
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "reserve",
  [lifetimeVault, lifetimeSecond, wholeApool(50)],
);
check(
  "vault.lifetimeCapCanBeReachedExactly",
  await read("AgentPoolV43EpochVault", lifetimeVault, "totalReserved"),
  wholeApool(150),
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "release",
  [lifetimeVault, lifetimeFirst],
);
await write(
  "AgentPoolV44EpochVaultHarness",
  harness,
  "release",
  [lifetimeVault, lifetimeSecond],
);
check(
  "vault.releasedLifetimeReservationsDoNotMint",
  await read("AgentPoolV43EpochVault", lifetimeVault, "totalReserved"),
  0n,
);

const report = {
  schema: "agentpool.mainnet.v44.local-rehearsal/v1",
  ok: checks.every((entry) => entry.passed),
  chainId: 8453,
  token,
  coreVault,
  evolutionVault,
  lifetimeVault,
  harness,
  userEscrow,
  transactions: transactionCount,
  gasSpent: gasSpent.toString(),
  checks,
  statefulCases,
  randomSeed: "0x44a91c3d",
  generatedAt: new Date().toISOString(),
};
const reportPath = path.join(
  ROOT,
  "outputs",
  "v44-mainnet-candidate-rehearsal.json",
);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) throw new Error(`V44_REHEARSAL_FAILED:${reportPath}`);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      transactions: transactionCount,
      checks: checks.length,
      reportPath,
    },
    null,
    2,
  )}\n`,
);
