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
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";

const root = process.cwd();
const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v4.3.7 Self Bootstrap Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("LOCAL_EVM_COMMON_FAILED");
const vm = await createVM({ common, activatePrecompiles: true });

const key = (index) =>
  hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
const address = (privateKey) =>
  getAddress(createAddressFromPrivateKey(privateKey).toString());
const deployerKey = key(1);
const aiKey = key(2);
const deployer = address(deployerKey);
const ai = address(aiKey);
for (const privateKey of [deployerKey, aiKey]) {
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(privateKey),
    createAccount({ nonce: 0n, balance: parseEther("100") }),
  );
}

const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
let blockNumber = 1n;
let blockTimestamp = BigInt(Math.floor(Date.now() / 1_000));
let transactionCount = 0;
const checks = [];

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

const write = (name, contract, functionName, args = [], signingKey = deployerKey) =>
  execute(
    encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    contract,
    signingKey,
  );

async function read(name, contract, functionName, args = []) {
  const caller = createAddressFromPrivateKey(deployerKey);
  const result = await vm.evm.runCall({
    caller,
    origin: caller,
    to: createAddressFromString(contract),
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
    checks.push({ name, passed: true });
    return;
  }
  throw new Error(`${name}_UNEXPECTEDLY_SUCCEEDED`);
}

function check(name, actual, expected) {
  const passed = actual === expected;
  checks.push({ name, passed, actual: String(actual), expected: String(expected) });
  if (!passed) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

const token = await deploy("MockV43Token");
const stage = await deploy("MockV437Stage");
const verifier = await deploy("AgentPoolV43HashObjectiveVerifier");
const financeInvariantHash = keccak256(
  toBytes(
    "max-supply|external-no-mint|reservation-cap|no-owner-withdrawal|no-evaluator-payout|receipt-replay",
  ),
);
const pool = await deploy("AgentPoolV437SelfBootstrapPool", [
  token,
  stage,
  stage,
  verifier,
  financeInvariantHash,
  parseEther("2"),
  parseEther("5"),
  parseEther("5"),
  parseEther("10"),
  8,
  30 * 86_400,
]);
await write("MockV43Token", token, "mint", [deployer, parseEther("10")]);
await write("MockV43Token", token, "approve", [pool, parseEther("10")]);
await write("AgentPoolV437SelfBootstrapPool", pool, "fund", [parseEther("10")]);

const parentRelease = keccak256(toBytes("v4.3.5"));
function evidence(label) {
  const specificationHash = keccak256(toBytes(`${label}:specification`));
  const deliveryHash = keccak256(toBytes(`${label}:delivery`));
  const proof = toHex(`${label}:proof`);
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
  return { specificationHash, deliveryHash, proof, expectedEvidenceHash };
}
function deadlines() {
  return [
    Number(blockTimestamp + 300n),
    Number(blockTimestamp + 600n),
    Number(blockTimestamp + 900n),
  ];
}
async function acceptItem(issueId, label, role, quote) {
  const item = {
    id: keccak256(toBytes(`${issueId}:${label}`)),
    role,
    quote: parseEther(quote),
    ...evidence(label),
  };
  await write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "acceptWorkBid",
    [
      issueId,
      item.id,
      ai,
      role,
      item.quote,
      item.specificationHash,
      item.expectedEvidenceHash,
    ],
    aiKey,
  );
  return item;
}
async function completeItem(item) {
  return write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "completeWork",
    [item.id, item.deliveryHash, item.proof],
    aiKey,
  );
}

const issue1 = keccak256(toBytes("v437-dynamic-issue-1"));
const issueHash1 = keccak256(toBytes("UNKNOWN_AGENT_STRUCTURED_ERROR"));
const release1 = keccak256(toBytes("v4.3.7-mcp-error-overlay"));
await write(
  "AgentPoolV437SelfBootstrapPool",
  pool,
  "openIssue",
  [
    issue1,
    issueHash1,
    2,
    parseEther("5"),
    keccak256(toBytes("structured unknown agent response")),
    parentRelease,
    release1,
    ...deadlines(),
  ],
  aiKey,
);
const planner = await acceptItem(issue1, "planner", 1, "0.5");
const reproducer = await acceptItem(issue1, "reproducer", 2, "0.5");
const implementer = await acceptItem(issue1, "implementer", 3, "2");
const validator = await acceptItem(issue1, "validator", 4, "1.5");
const keeper = await acceptItem(issue1, "keeper", 5, "0.5");
await completeItem(planner);
await expectRevert("implementation cannot skip reproduction", () =>
  completeItem(implementer),
);
await completeItem(reproducer);
await completeItem(implementer);
await expectRevert("one delivery cannot be reused for another role", () =>
  write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "completeWork",
    [validator.id, implementer.deliveryHash, validator.proof],
    aiKey,
  ),
);
await completeItem(validator);
await completeItem(keeper);
await write(
  "AgentPoolV437SelfBootstrapPool",
  pool,
  "settleIssue",
  [issue1],
  aiKey,
);

check(
  "same AI receives the sum of five distinct proven role bids",
  await read("MockV43Token", token, "balanceOf", [ai]),
  parseEther("5"),
);
check(
  "dynamic role quotes settle exactly once",
  await read("AgentPoolV437SelfBootstrapPool", pool, "totalPaid"),
  parseEther("5"),
);
check(
  "candidate is incubation proven only",
  await read(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "incubationProvenRelease",
    [release1],
  ),
  true,
);
await expectRevert("duplicate issue evidence cannot farm twice", () =>
  write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "openIssue",
    [
      keccak256(toBytes("duplicate-id")),
      issueHash1,
      2,
      parseEther("1"),
      keccak256(toBytes("duplicate")),
      parentRelease,
      keccak256(toBytes("duplicate-release")),
      ...deadlines(),
    ],
    aiKey,
  ),
);

blockTimestamp += 86_400n;
const issue2 = keccak256(toBytes("v437-dynamic-issue-2"));
const release2 = keccak256(toBytes("v4.3.7-runner-gas-overlay"));
await write(
  "AgentPoolV437SelfBootstrapPool",
  pool,
  "openIssue",
  [
    issue2,
    keccak256(toBytes("RUNNER_LOW_GAS")),
    1,
    parseEther("3"),
    keccak256(toBytes("runner default minimum gas")),
    parentRelease,
    release2,
    ...deadlines(),
  ],
  aiKey,
);
const reproduction2 = await acceptItem(issue2, "runner-reproduction", 2, "0.5");
const implementation2 = await acceptItem(issue2, "runner-implementation", 3, "1.5");
const validation2 = await acceptItem(issue2, "runner-validation", 4, "1");
await expectRevert("one line item cannot quote above its immutable cap", () =>
  write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "acceptWorkBid",
    [
      issue2,
      keccak256(toBytes("over-item-cap")),
      ai,
      5,
      parseEther("2.1"),
      keccak256(toBytes("over-item-cap-spec")),
      keccak256(toBytes("over-item-cap-evidence")),
    ],
    aiKey,
  ),
);
await write("MockV437Stage", stage, "setTransitionReady", [true]);
await write("AgentPoolV437SelfBootstrapPool", pool, "syncGraduation");
check(
  "bootstrap graduates one way when independent transition is ready",
  await read("AgentPoolV437SelfBootstrapPool", pool, "graduated"),
  true,
);
await expectRevert("graduation blocks new self-issued work", () =>
  write(
    "AgentPoolV437SelfBootstrapPool",
    pool,
    "openIssue",
    [
      keccak256(toBytes("after-graduation")),
      keccak256(toBytes("after-graduation-hash")),
      1,
      parseEther("1"),
      keccak256(toBytes("after-graduation-spec")),
      parentRelease,
      keccak256(toBytes("after-graduation-release")),
      ...deadlines(),
    ],
    aiKey,
  ),
);
await completeItem(reproduction2);
await completeItem(implementation2);
await completeItem(validation2);
await write(
  "AgentPoolV437SelfBootstrapPool",
  pool,
  "settleIssue",
  [issue2],
  aiKey,
);
check(
  "graduation does not strand already reserved work",
  await read("AgentPoolV437SelfBootstrapPool", pool, "totalReserved"),
  0n,
);
check(
  "two issues pay eight tAPOOL across independently priced work",
  await read("MockV43Token", token, "balanceOf", [ai]),
  parseEther("8"),
);
await expectRevert("pool can never be funded beyond lifetime cap", () =>
  write("AgentPoolV437SelfBootstrapPool", pool, "fund", [1n]),
);

const report = {
  ok: checks.every(({ passed }) => passed),
  transactions: transactionCount,
  checks,
  financeInvariantHash,
  caps: {
    maxItemQuoteApool: "2",
    maxIssueBudgetApool: "5",
    dailyApool: "5",
    lifetimeApool: "10",
  },
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v437-self-bootstrap-rehearsal.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ ok: report.ok, transactions: transactionCount, checks: checks.length })}\n`,
);
