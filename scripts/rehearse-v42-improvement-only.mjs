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

const root = process.cwd();
const common = createCustomCommon(
  { chainId: 31337, name: "AgentPool v4.2 Improvement-only Rehearsal" },
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

const deployerKey = hexToBytes(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const roles = {
  reporter: { key: deployerKey, address: addressFor(deployerKey) },
  reproducers: [2, 3, 4, 5].map((index) => ({
    key: rehearsalKey(index),
    address: addressFor(rehearsalKey(index)),
  })),
  authorA: { key: rehearsalKey(6), address: addressFor(rehearsalKey(6)) },
  authorB: { key: rehearsalKey(7), address: addressFor(rehearsalKey(7)) },
  planner: { key: rehearsalKey(8), address: addressFor(rehearsalKey(8)) },
  evaluators: [9, 10, 11].map((index) => ({
    key: rehearsalKey(index),
    address: addressFor(rehearsalKey(index)),
  })),
  keeper: { key: rehearsalKey(12), address: addressFor(rehearsalKey(12)) },
};
const allKeys = [
  roles.reporter.key,
  ...roles.reproducers.map((entry) => entry.key),
  roles.authorA.key,
  roles.authorB.key,
  roles.planner.key,
  ...roles.evaluators.map((entry) => entry.key),
  roles.keeper.key,
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

async function expectRevert(label, action) {
  try {
    await action();
  } catch {
    checks.push({
      name: label,
      passed: true,
      actual: "reverted",
      expected: "reverted",
    });
    return;
  }
  checks.push({
    name: label,
    passed: false,
    actual: "succeeded",
    expected: "reverted",
  });
  throw new Error(`${label}_UNEXPECTEDLY_SUCCEEDED`);
}

function issueEvidence(issueHash, reproducer, proof) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [issueHash, reproducer, keccak256(proof)],
    ),
  );
}

function reproductionCommitment(evidenceHash, proof, salt) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [evidenceHash, keccak256(proof), salt],
    ),
  );
}

function evaluationCommitment(score, evidenceHash, salt) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }],
      [score, evidenceHash, salt],
    ),
  );
}

const token = await deploy("AgentPoolV42Token", [roles.reporter.address]);
const improvementVerifier = await deploy(
  "AgentPoolV42HashImprovementVerifier",
);
const verifierCodehash = keccak256(
  artifact("AgentPoolV42HashImprovementVerifier").deployedBytecode,
);
const issueHash = keccak256(toBytes("agentpool-v42-indexer-recovery-issue"));
const reporterProof = toHex("reproducible-indexer-gap-transcript");
const evidenceHash = issueEvidence(
  issueHash,
  roles.reporter.address,
  reporterProof,
);
const maxBudget = parseEther("1000");
const innerLeaf = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint128" },
      { type: "bool" },
    ],
    [issueHash, evidenceHash, verifierCodehash, maxBudget, false],
  ),
);
const genesisRoot = keccak256(innerLeaf);
const genesisStart = Number(blockTimestamp + 30n);
const kernel = await deploy("AgentPoolV42ImprovementKernel", [
  token,
  genesisRoot,
  genesisStart,
  verifierCodehash,
]);
const userEscrow = await deploy("AgentPoolV42UserEscrow", [token]);
const jobVerifier = await deploy("AgentPoolV41HashVerifier");
await write("AgentPoolV42Token", token, "setImprovementKernel", [kernel]);

check(
  "v4.2 begins with zero premint",
  await read("AgentPoolV42Token", token, "totalSupply"),
  0n,
);
check(
  "only improvement kernel is configured to mint",
  await read("AgentPoolV42Token", token, "improvementKernel"),
  kernel,
);
await expectRevert("deployer has no mint authority", () =>
  write("AgentPoolV42Token", token, "mint", [
    roles.reporter.address,
    parseEther("1"),
  ]),
);
await expectRevert("minter cannot be replaced", () =>
  write("AgentPoolV42Token", token, "setImprovementKernel", [
    roles.reporter.address,
  ]),
);
check(
  "bootstrap objective verifier code is approved",
  await read(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "approvedVerifierCodehash",
    [verifierCodehash],
  ),
  true,
);
const kernelFunctions = artifact("AgentPoolV42ImprovementKernel").abi
  .filter((entry) => entry.type === "function")
  .map((entry) => entry.name.toLowerCase());
check(
  "kernel exposes no generic basic mining lane",
  kernelFunctions.some(
    (name) =>
      name.includes("basic") ||
      name.includes("mining") ||
      name.includes("lane"),
  ),
  false,
);

blockTimestamp = BigInt(genesisStart + 1);
const reproductionDeadline = Number(blockTimestamp + 100n);
const candidateDeadline = Number(blockTimestamp + 200n);
const canaryDeadline = Number(blockTimestamp + 300n);
const badIssueHash = keccak256(toBytes("not-in-genesis-root"));
const badProof = toHex("bad-issue-proof");
const badEvidence = issueEvidence(
  badIssueHash,
  roles.reporter.address,
  badProof,
);
await expectRevert("unlisted zero-bond issue cannot open", () =>
  write("AgentPoolV42ImprovementKernel", kernel, "openIssue", [
    badIssueHash,
    badEvidence,
    improvementVerifier,
    maxBudget,
    parseEther("50"),
    parseEther("50"),
    0n,
    reproductionDeadline,
    candidateDeadline,
    canaryDeadline,
    false,
    badProof,
    [],
  ]),
);

await write("AgentPoolV42ImprovementKernel", kernel, "openIssue", [
  issueHash,
  evidenceHash,
  improvementVerifier,
  maxBudget,
  parseEther("50"),
  parseEther("50"),
  0n,
  reproductionDeadline,
  candidateDeadline,
  canaryDeadline,
  false,
  reporterProof,
  [],
]);
let issue = await read(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "issues",
  [1n],
);
check("whitelisted issue enters reproduction", issue[13], 1);
check("issue is marked genesis bootstrap", issue[14], true);
await expectRevert("same evidence cannot open twice", () =>
  write("AgentPoolV42ImprovementKernel", kernel, "openIssue", [
    issueHash,
    evidenceHash,
    improvementVerifier,
    maxBudget,
    parseEther("50"),
    parseEther("50"),
    0n,
    reproductionDeadline,
    candidateDeadline,
    canaryDeadline,
    false,
    reporterProof,
    [],
  ]),
);
await expectRevert("reporter cannot reproduce own issue", () =>
  write("AgentPoolV42ImprovementKernel", kernel, "commitReproduction", [
    1n,
    keccak256(toBytes("reporter-commitment")),
    parseEther("20"),
    0n,
  ]),
);

const reproductionEntries = roles.reproducers.map((entry, index) => {
  const proof = toHex(`independent-reproduction-${index + 1}`);
  const correctEvidence = issueEvidence(issueHash, entry.address, proof);
  const evidence =
    index === 3 ? keccak256(toBytes("invalid-reproduction-evidence")) : correctEvidence;
  const salt = keccak256(toBytes(`reproduction-salt-${index + 1}`));
  return {
    ...entry,
    proof,
    evidence,
    salt,
    commitment: reproductionCommitment(evidence, proof, salt),
  };
});
for (const entry of reproductionEntries) {
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "commitReproduction",
    [1n, entry.commitment, parseEther("20"), 0n],
    entry.key,
  );
}
await expectRevert("changed reproduction reveal is rejected", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "revealReproduction",
    [
      1n,
      reproductionEntries[0].evidence,
      reproductionEntries[0].proof,
      keccak256(toBytes("wrong-salt")),
    ],
    reproductionEntries[0].key,
  ),
);
for (const entry of reproductionEntries) {
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "revealReproduction",
    [1n, entry.evidence, entry.proof, entry.salt],
    entry.key,
  );
}
const invalidReproduction = await read(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "reproductionAt",
  [1n, 3n],
);
check(
  "objective verifier rejects invalid reproduction evidence",
  invalidReproduction.passed,
  false,
);

blockTimestamp = BigInt(reproductionDeadline + 1);
await expectRevert("reproducible issue cannot be bypass-expired", () =>
  write("AgentPoolV42ImprovementKernel", kernel, "expireIssue", [1n]),
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "finalizeReproduction",
  [1n],
  roles.keeper.key,
);
issue = await read("AgentPoolV42ImprovementKernel", kernel, "issues", [1n]);
check("reproduced issue enters candidate auction", issue[13], 2);
check(
  "maximum issue budget is reserved before work",
  await read("AgentPoolV42ImprovementKernel", kernel, "epochReserved", [0]),
  maxBudget,
);

const codeHashA = keccak256(toBytes("candidate-module-a"));
const manifestHashA = keccak256(toBytes("candidate-manifest-a"));
const codeHashB = keccak256(toBytes("candidate-module-b"));
const manifestHashB = keccak256(toBytes("candidate-manifest-b"));
await expectRevert("reproducer cannot submit the candidate", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "submitCandidate",
    [
      1n,
      roles.planner.address,
      codeHashA,
      manifestHashA,
      parseEther("250"),
      parseEther("40"),
      parseEther("40"),
      0n,
    ],
    roles.reproducers[0].key,
  ),
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "submitCandidate",
  [
    1n,
    roles.planner.address,
    codeHashA,
    manifestHashA,
    parseEther("300"),
    parseEther("50"),
    parseEther("50"),
    0n,
  ],
  roles.authorA.key,
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "submitCandidate",
  [
    1n,
    roles.planner.address,
    codeHashB,
    manifestHashB,
    parseEther("250"),
    parseEther("40"),
    parseEther("40"),
    0n,
  ],
  roles.authorB.key,
);
issue = await read("AgentPoolV42ImprovementKernel", kernel, "issues", [1n]);
check("lower complete bid wins the reverse auction", issue[12], 2);

blockTimestamp = BigInt(candidateDeadline + 1);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "awardCandidate",
  [1n],
  roles.keeper.key,
);
const candidateProof = toHex("isolated-canary-transcript-b");
const deliveryHash = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "bytes32" },
    ],
    [
      issueHash,
      codeHashB,
      manifestHashB,
      roles.authorB.address,
      keccak256(candidateProof),
    ],
  ),
);
await expectRevert("losing candidate cannot deliver", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "deliverCandidate",
    [1n, deliveryHash, candidateProof],
    roles.authorA.key,
  ),
);
await expectRevert("invalid canary proof cannot be delivered", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "deliverCandidate",
    [1n, keccak256(toBytes("wrong-delivery")), candidateProof],
    roles.authorB.key,
  ),
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "deliverCandidate",
  [1n, deliveryHash, candidateProof],
  roles.authorB.key,
);
await expectRevert("worker-role address cannot evaluate its own flow", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "commitEvaluation",
    [
      1n,
      keccak256(toBytes("role-conflict-evaluation")),
      parseEther("30"),
      0n,
    ],
    roles.reproducers[0].key,
  ),
);

const evaluationEntries = roles.evaluators.map((entry, index) => {
  const score = [7_000, 8_000, 9_000][index];
  const fee = parseEther(["30", "35", "40"][index]);
  const evidence = keccak256(toBytes(`blind-canary-evidence-${index + 1}`));
  const salt = keccak256(toBytes(`evaluation-salt-${index + 1}`));
  return {
    ...entry,
    score,
    fee,
    evidence,
    salt,
    commitment: evaluationCommitment(score, evidence, salt),
  };
});
for (const entry of evaluationEntries) {
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "commitEvaluation",
    [1n, entry.commitment, entry.fee, 0n],
    entry.key,
  );
}
for (const entry of evaluationEntries) {
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "revealEvaluation",
    [1n, entry.score, entry.evidence, entry.salt],
    entry.key,
  );
}

blockTimestamp = BigInt(canaryDeadline + 1);
await expectRevert("complete canary cannot be bypass-expired", () =>
  write("AgentPoolV42ImprovementKernel", kernel, "expireIssue", [1n]),
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "finalizeImprovement",
  [1n],
  roles.keeper.key,
);
issue = await read("AgentPoolV42ImprovementKernel", kernel, "issues", [1n]);
check("passing improvement reaches PROVEN", issue[13], 4);
const expectedEmission = parseEther("555");
check(
  "only proven improvement work creates supply",
  await read("AgentPoolV42Token", token, "totalSupply"),
  expectedEmission,
);
check(
  "false reproduction receives no reward",
  await read("AgentPoolV42Token", token, "balanceOf", [
    roles.reproducers[3].address,
  ]),
  0n,
);
check(
  "successful author receives its exact dynamic bid",
  await read("AgentPoolV42Token", token, "balanceOf", [
    roles.authorB.address,
  ]),
  parseEther("250"),
);
check(
  "planner receives its exact dynamic bid",
  await read("AgentPoolV42Token", token, "balanceOf", [
    roles.planner.address,
  ]),
  parseEther("40"),
);
check(
  "unused reserved budget is not emitted",
  await read("AgentPoolV42ImprovementKernel", kernel, "epochReserved", [0]),
  0n,
);
check(
  "epoch emission records only actual settlement",
  await read("AgentPoolV42ImprovementKernel", kernel, "epochMinted", [0]),
  expectedEmission,
);

const supplyBeforeFailedIssue = await read(
  "AgentPoolV42Token",
  token,
  "totalSupply",
);
const failedIssueHash = keccak256(
  toBytes("agentpool-v42-invalid-candidate-issue"),
);
const failedIssueProof = toHex("second-objective-issue-transcript");
const failedIssueEvidence = issueEvidence(
  failedIssueHash,
  roles.authorB.address,
  failedIssueProof,
);
const failedIssueBudget = parseEther("200");
const failedReproductionDeadline = Number(blockTimestamp + 60n);
const failedCandidateDeadline = Number(blockTimestamp + 120n);
const failedCanaryDeadline = Number(blockTimestamp + 180n);
await write(
  "AgentPoolV42Token",
  token,
  "approve",
  [kernel, parseEther("10")],
  roles.authorB.key,
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "openIssue",
  [
    failedIssueHash,
    failedIssueEvidence,
    improvementVerifier,
    failedIssueBudget,
    parseEther("10"),
    parseEther("10"),
    parseEther("10"),
    failedReproductionDeadline,
    failedCandidateDeadline,
    failedCanaryDeadline,
    false,
    failedIssueProof,
    [],
  ],
  roles.authorB.key,
);
for (let index = 0; index < 3; index += 1) {
  const actor = roles.reproducers[index];
  const proof = toHex(`failed-issue-valid-reproduction-${index + 1}`);
  const evidence = issueEvidence(failedIssueHash, actor.address, proof);
  const salt = keccak256(toBytes(`failed-issue-repro-salt-${index + 1}`));
  await write(
    "AgentPoolV42Token",
    token,
    "approve",
    [kernel, parseEther("10")],
    actor.key,
  );
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "commitReproduction",
    [
      2n,
      reproductionCommitment(evidence, proof, salt),
      parseEther("5"),
      parseEther("10"),
    ],
    actor.key,
  );
  await write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "revealReproduction",
    [2n, evidence, proof, salt],
    actor.key,
  );
}
blockTimestamp = BigInt(failedReproductionDeadline + 1);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "finalizeReproduction",
  [2n],
  roles.keeper.key,
);
await write(
  "AgentPoolV42Token",
  token,
  "approve",
  [kernel, parseEther("10")],
  roles.planner.key,
);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "submitCandidate",
  [
    2n,
    "0x0000000000000000000000000000000000000000",
    keccak256(toBytes("failed-candidate-code")),
    keccak256(toBytes("failed-candidate-manifest")),
    parseEther("50"),
    0n,
    parseEther("10"),
    parseEther("10"),
  ],
  roles.planner.key,
);
blockTimestamp = BigInt(failedCandidateDeadline + 1);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "awardCandidate",
  [2n],
  roles.keeper.key,
);
await expectRevert("invalid candidate proof cannot earn or register", () =>
  write(
    "AgentPoolV42ImprovementKernel",
    kernel,
    "deliverCandidate",
    [
      2n,
      keccak256(toBytes("invalid-candidate-delivery")),
      toHex("invalid-candidate-proof"),
    ],
    roles.planner.key,
  ),
);
blockTimestamp = BigInt(failedCanaryDeadline + 1);
await write(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "expireIssue",
  [2n],
  roles.keeper.key,
);
const failedIssue = await read(
  "AgentPoolV42ImprovementKernel",
  kernel,
  "issues",
  [2n],
);
check("undelivered improvement expires", failedIssue[13], 6);
check(
  "failed improvement releases all emission reservation",
  await read("AgentPoolV42ImprovementKernel", kernel, "epochReserved", [0]),
  0n,
);
check(
  "failed improvement mints nothing",
  await read("AgentPoolV42Token", token, "totalSupply"),
  supplyBeforeFailedIssue,
);
check(
  "undelivered selected-candidate bond enters slash reuse pool",
  await read("AgentPoolV42ImprovementKernel", kernel, "slashPool"),
  parseEther("10"),
);

const supplyBeforeExternalJob = await read(
  "AgentPoolV42Token",
  token,
  "totalSupply",
);
const jobBudget = parseEther("30");
const jobKeeperFee = parseEther("5");
const workerBond = parseEther("5");
await write(
  "AgentPoolV42Token",
  token,
  "approve",
  [userEscrow, jobBudget + jobKeeperFee],
  roles.authorB.key,
);
await write(
  "AgentPoolV42Token",
  token,
  "approve",
  [userEscrow, workerBond],
  roles.planner.key,
);
const specificationHash = keccak256(toBytes("external-json-normalization"));
const jobDeliveryHash = keccak256(toBytes("normalized-json-artifact"));
const jobProof = toHex("deterministic-external-job-proof");
const expectedJobEvidence = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [specificationHash, jobDeliveryHash, keccak256(jobProof)],
  ),
);
const jobDeadline = Number(blockTimestamp + 100n);
await write(
  "AgentPoolV42UserEscrow",
  userEscrow,
  "fundJob",
  [
    roles.planner.address,
    jobVerifier,
    jobBudget,
    workerBond,
    jobKeeperFee,
    jobDeadline,
    specificationHash,
    expectedJobEvidence,
    [roles.planner.address],
    [jobBudget],
  ],
  roles.authorB.key,
);
await write(
  "AgentPoolV42UserEscrow",
  userEscrow,
  "accept",
  [1n],
  roles.planner.key,
);
await write(
  "AgentPoolV42UserEscrow",
  userEscrow,
  "deliver",
  [1n, jobDeliveryHash],
  roles.planner.key,
);
const workerBalanceBeforeSettlement = await read(
  "AgentPoolV42Token",
  token,
  "balanceOf",
  [roles.planner.address],
);
await write(
  "AgentPoolV42UserEscrow",
  userEscrow,
  "resolve",
  [1n, jobProof, [roles.planner.address], [jobBudget]],
  roles.keeper.key,
);
check(
  "external job transfers the exact existing-token budget",
  await read("AgentPoolV42Token", token, "balanceOf", [
    roles.planner.address,
  ]),
  workerBalanceBeforeSettlement + jobBudget + workerBond,
);
check(
  "external job keeper is paid by the buyer",
  await read("AgentPoolV42Token", token, "balanceOf", [
    roles.keeper.address,
  ]),
  parseEther("55"),
);
check(
  "external job creates no new tAPOOL",
  await read("AgentPoolV42Token", token, "totalSupply"),
  supplyBeforeExternalJob,
);
check(
  "successful external escrow leaves no stuck balance",
  await read("AgentPoolV42Token", token, "balanceOf", [userEscrow]),
  0n,
);

const requiredContracts = [
  token,
  kernel,
  improvementVerifier,
  userEscrow,
  jobVerifier,
];
for (const address of requiredContracts) {
  const code = await vm.stateManager.getCode(createAddressFromString(address));
  if (code.length === 0 || code.length > 24_576) {
    throw new Error(`${address}_INVALID_RUNTIME_CODE_SIZE:${code.length}`);
  }
}

const report = {
  version: "4.2.0-alpha",
  chainId: 31337,
  architecture: "improvement-only-emission",
  basicMiningLane: false,
  transactionCount,
  gasSpent: gasSpent.toString(),
  contracts: {
    token,
    improvementKernel: kernel,
    improvementVerifier,
    userEscrow,
    jobVerifier,
  },
  issuance: {
    improvementSettlement: expectedEmission.toString(),
    externalJobEmission: "0",
  },
  checks,
  passed: checks.every((entry) => entry.passed),
};
const output = path.join(root, "outputs", "v42-local-rehearsal.json");
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
