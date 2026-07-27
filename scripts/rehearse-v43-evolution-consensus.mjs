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
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
} from "viem";

const root = process.cwd();
const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v4.3 Evolution Rehearsal" },
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
const agents = Array.from({ length: 10 }, (_, index) => {
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
  if (!artifactCache.has(name)) {
    artifactCache.set(
      name,
      JSON.parse(
        fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
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

const deployer = addressFor(deployerKey);
const token = await deploy("MockV43Token");
const sourceA = await deploy("MockV43SettlementSource");
const sourceB = await deploy("MockV43SettlementSource");
const genesisStart = Number(blockTimestamp + 10n);
const ledger = await deploy("AgentPoolV43ContributionLedger", [
  genesisStart,
  sourceA,
  deployer,
]);
const financeInvariantHash = keccak256(
  toBytes(
    "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout",
  ),
);
const genesisRelease = keccak256(toBytes("agentpool-v4.2"));
const proposalBond = parseEther("10");
const consensus = await deploy("AgentPoolV43EvolutionConsensus", [
  token,
  ledger,
  financeInvariantHash,
  genesisRelease,
  proposalBond,
]);
await write("MockV43SettlementSource", sourceA, "configure", [
  ledger,
  consensus,
]);
await write("MockV43SettlementSource", sourceB, "configure", [
  ledger,
  consensus,
]);
await write("AgentPoolV43ContributionLedger", ledger, "configureConsensus", [
  consensus,
]);

check(
  "bootstrap authority is permanently removed",
  await read("AgentPoolV43ContributionLedger", ledger, "bootstrapAuthority"),
  "0x0000000000000000000000000000000000000000",
);
check(
  "genesis settlement source is active",
  await read("AgentPoolV43ContributionLedger", ledger, "isActiveSource", [
    sourceA,
  ]),
  true,
);
check(
  "candidate source is inactive before consensus",
  await read("AgentPoolV43ContributionLedger", ledger, "isActiveSource", [
    sourceB,
  ]),
  false,
);

blockTimestamp = BigInt(genesisStart + 1);
for (let index = 0; index < agents.length; index++) {
  const group = keccak256(toBytes(`operator-group-${index % 5}`));
  const runtimeHash = keccak256(toBytes(`runtime-${index}`));
  await write(
    "AgentPoolV43ContributionLedger",
    ledger,
    "register",
    [group, runtimeHash],
    agents[index].key,
  );
  await write("MockV43SettlementSource", sourceA, "record", [
    keccak256(toBytes(`work-receipt-${index}`)),
    agents[index].address,
    1_000n,
    true,
  ]);
}

check(
  "recent objective work is the voting-power source",
  await read(
    "AgentPoolV43ContributionLedger",
    ledger,
    "totalSuccessfulAt",
    [0, 8],
  ),
  10_000n,
);
check(
  "one agent is capped at ten percent of recent contribution",
  await read(
    "AgentPoolV43ContributionLedger",
    ledger,
    "votingPowerAt",
    [agents[0].address, 0, 8],
  ),
  1_000n,
);
await expectRevert("inactive source cannot fabricate work power", () =>
  write("MockV43SettlementSource", sourceB, "record", [
    keccak256(toBytes("fabricated-receipt")),
    agents[0].address,
    10_000n,
    true,
  ]),
);
await expectRevert("one receipt cannot be counted twice", () =>
  write("MockV43SettlementSource", sourceA, "record", [
    keccak256(toBytes("work-receipt-0")),
    agents[0].address,
    1_000n,
    true,
  ]),
);

await write("MockV43Token", token, "mint", [
  agents[0].address,
  parseEther("100"),
]);
await write(
  "MockV43Token",
  token,
  "approve",
  [consensus, proposalBond],
  agents[0].key,
);

const releaseId = keccak256(toBytes("agentpool-v4.3-autonomous-market"));
const moduleHash = keccak256(toBytes("v4.3-module-bytecode"));
const manifestHash = keccak256(toBytes("v4.3-release-manifest"));
const commitDeadline = Number(blockTimestamp + 86_500n);
const revealDeadline = commitDeadline + 86_500;
const adoptionDeadline = revealDeadline + 86_500;
const canary = {
  qualityBps: 9_300,
  baselineQualityBps: 9_100,
  cost: 900,
  baselineCost: 1_000,
  latency: 1_000,
  baselineLatency: 1_000,
  securityRegressions: 0,
};
const candidateReceiptId = keccak256(
  toBytes("settled-system-improvement-candidate"),
);
await write("MockV43SettlementSource", sourceA, "attest", [
  candidateReceiptId,
  agents[0].address,
  moduleHash,
  manifestHash,
  canary,
]);

await expectRevert("financial invariants cannot be voted away", () =>
  write(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "proposeRelease",
    [
      candidateReceiptId,
      genesisRelease,
      keccak256(toBytes("invalid-finance-release")),
      moduleHash,
      manifestHash,
      keccak256(toBytes("changed-finance-rules")),
      sourceB,
      true,
      canary,
      proposalBond,
      commitDeadline,
      revealDeadline,
      adoptionDeadline,
    ],
    agents[0].key,
  ),
);

await write(
  "AgentPoolV43EvolutionConsensus",
  consensus,
  "proposeRelease",
  [
    candidateReceiptId,
    genesisRelease,
    releaseId,
    moduleHash,
    manifestHash,
    financeInvariantHash,
    sourceB,
    true,
    canary,
    proposalBond,
    commitDeadline,
    revealDeadline,
    adoptionDeadline,
  ],
  agents[0].key,
);

const salts = agents.slice(0, 5).map((_, index) =>
  keccak256(toBytes(`vote-salt-${index}`)),
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
  "one participant cannot activate the candidate during commit",
  await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "recommendedRelease",
  ),
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
await write(
  "AgentPoolV43EvolutionConsensus",
  consensus,
  "finalizeVote",
  [1n],
);
check(
  "contribution supermajority proves but does not yet recommend release",
  await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "releaseStates",
    [releaseId],
  ),
  2,
);
check(
  "voting alone cannot change the recommended release",
  await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "recommendedRelease",
  ),
  genesisRelease,
);

for (let index = 0; index < 5; index++) {
  await write("MockV43SettlementSource", sourceA, "adopt", [
    1n,
    agents[index].address,
    keccak256(toBytes(`candidate-adoption-${index}`)),
  ]);
}
check(
  "independent adoption recommends the candidate",
  await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "recommendedRelease",
  ),
  releaseId,
);
check(
  "new settlement source activates only after vote and adoption",
  await read("AgentPoolV43ContributionLedger", ledger, "isActiveSource", [
    sourceB,
  ]),
  true,
);
check(
  "genesis release remains available and is never overwritten",
  await read(
    "AgentPoolV43EvolutionConsensus",
    consensus,
    "releaseStates",
    [genesisRelease],
  ),
  3,
);
check(
  "successful proposal bond is returned",
  await read("MockV43Token", token, "balanceOf", [agents[0].address]),
  parseEther("100"),
);

const output = {
  schemaVersion: 1,
  network: "in-memory-cancun",
  chainId: 31337,
  contracts: { token, sourceA, sourceB, ledger, consensus },
  financeInvariantHash,
  genesisRelease,
  recommendedRelease: releaseId,
  transactionCount,
  gasSpent: gasSpent.toString(),
  checks,
  passed: checks.every((entry) => entry.passed),
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v43-evolution-rehearsal.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(output)}\n`);
