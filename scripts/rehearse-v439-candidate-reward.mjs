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
  { chainId: 84_532, name: "AgentPool v4.3.9 Candidate Reward Rehearsal" },
  Mainnet,
  { hardfork: Hardfork.Cancun },
);
if (!(common instanceof Common)) throw new Error("V439_COMMON_FAILED");
const vm = await createVM({ common, activatePrecompiles: true });

const key = (index) =>
  hexToBytes(`0x${BigInt(index).toString(16).padStart(64, "0")}`);
const address = (privateKey) =>
  getAddress(createAddressFromPrivateKey(privateKey).toString());
const deployerKey = key(1);
const agentKey = key(2);
const competingAgentKey = key(3);
const deployer = address(deployerKey);
const agent = address(agentKey);
const competingAgent = address(competingAgentKey);
for (const privateKey of [deployerKey, agentKey, competingAgentKey]) {
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
      `V439_LOCAL_EVM_REVERT:${result.execResult.exceptionError.error}:${bytesToHex(result.execResult.returnValue)}`,
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
  if (!result.createdAddress) throw new Error(`${name}_DEPLOYMENT_FAILED`);
  const code = await vm.stateManager.getCode(result.createdAddress);
  if (code.length === 0 || code.length > 24_576) {
    throw new Error(`${name}_INVALID_CODE_SIZE:${code.length}`);
  }
  return getAddress(result.createdAddress.toString());
}

const write = (
  name,
  contract,
  functionName,
  args = [],
  signingKey = deployerKey,
) =>
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
  checks.push({
    name,
    passed,
    actual: String(actual),
    expected: String(expected),
  });
  if (!passed) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

const token = await deploy("MockV43Token");
const groups = await deploy("MockV439GroupRegistry");
const pool = await deploy("AgentPoolV439CandidateRewardPool", [
  token,
  groups,
  parseEther("1"),
  parseEther("3"),
  parseEther("1"),
  parseEther("5"),
  parseEther("5"),
  parseEther("10"),
  8_000,
  1,
  1,
  8,
  5,
  7 * 86_400,
]);
await write("MockV43Token", token, "mint", [deployer, parseEther("10")]);
await write("MockV43Token", token, "approve", [pool, parseEther("10")]);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "fund",
  [parseEther("10")],
);

const issueId = keccak256(toBytes("v439:null-vote-issue"));
const issueDigest = keccak256(toBytes("decideWorkPowerVote:null"));
const sourceSnapshot = keccak256(toBytes("source:snapshot:1"));
const acceptanceDigest = keccak256(toBytes("null votes return rejection"));
const planHash = keccak256(toBytes("defensive-array-normalization"));
const planSalt = keccak256(toBytes("plan-salt"));
const artifactDigest = keccak256(toBytes("immutable-candidate-artifact"));
const patchDigest = keccak256(toBytes("candidate-patch"));
const evidenceDigest = keccak256(toBytes("independent-replay-evidence"));
const validationSalt = keccak256(toBytes("validation-salt"));
const planCommitment = await read(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "candidatePlanCommitment",
  [issueId, agent, planHash, planSalt],
);
const deadlines = {
  bid: Number(blockTimestamp + 100n),
  delivery: Number(blockTimestamp + 200n),
  commit: Number(blockTimestamp + 300n),
  reveal: Number(blockTimestamp + 400n),
};
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "openIssue",
  [
    issueId,
    issueDigest,
    sourceSnapshot,
    acceptanceDigest,
    parseEther("5"),
    parseEther("0.5"),
    deadlines.bid,
    deadlines.delivery,
    deadlines.commit,
    deadlines.reveal,
  ],
  agentKey,
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "submitCandidateBid",
  [issueId, parseEther("2.5"), keccak256(toBytes("expensive-plan"))],
  competingAgentKey,
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "submitCandidateBid",
  [issueId, parseEther("2"), planCommitment],
  agentKey,
);
blockTimestamp = BigInt(deadlines.bid + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "awardCandidate",
  [issueId],
  competingAgentKey,
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "deliverCandidate",
  [issueId, planHash, planSalt, artifactDigest, patchDigest],
  agentKey,
);
const validationCommitment = await read(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "validationCommitment",
  [issueId, agent, artifactDigest, 9_500, evidenceDigest, validationSalt],
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "commitValidation",
  [issueId, validationCommitment, parseEther("1")],
  agentKey,
);
await expectRevert("validation reveal cannot front-run commit deadline", () =>
  write(
    "AgentPoolV439CandidateRewardPool",
    pool,
    "revealValidation",
    [issueId, 9_500, evidenceDigest, validationSalt],
    agentKey,
  ),
);
blockTimestamp = BigInt(deadlines.commit + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "revealValidation",
  [issueId, 9_500, evidenceDigest, validationSalt],
  agentKey,
);
blockTimestamp = BigInt(deadlines.reveal + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "finalizeIssue",
  [issueId],
  competingAgentKey,
);

check(
  "one AI receives the sum of reporter, implementer, and validator quotes",
  await read("MockV43Token", token, "balanceOf", [agent]),
  parseEther("3.5"),
);
check(
  "only proven role quotes leave the finite pool",
  await read("AgentPoolV439CandidateRewardPool", pool, "totalPaid"),
  parseEther("3.5"),
);
check(
  "unused issue budget is released",
  await read("AgentPoolV439CandidateRewardPool", pool, "totalReserved"),
  0n,
);
check(
  "the immutable artifact is incubation proven",
  await read(
    "AgentPoolV439CandidateRewardPool",
    pool,
    "provenArtifact",
    [artifactDigest],
  ),
  true,
);
check(
  "the more expensive candidate receives no payment",
  await read("MockV43Token", token, "balanceOf", [competingAgent]),
  0n,
);
await expectRevert("settlement cannot pay the same roles twice", () =>
  write(
    "AgentPoolV439CandidateRewardPool",
    pool,
    "finalizeIssue",
    [issueId],
    agentKey,
  ),
);
await expectRevert("finite pool cannot be funded beyond its lifetime cap", () =>
  write("AgentPoolV439CandidateRewardPool", pool, "fund", [1n]),
);

blockTimestamp += 86_400n;
const expiredIssue = keccak256(toBytes("v439:expired"));
const expiredBid = Number(blockTimestamp + 30n);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "openIssue",
  [
    expiredIssue,
    keccak256(toBytes("expired-issue-digest")),
    sourceSnapshot,
    acceptanceDigest,
    parseEther("2"),
    0n,
    expiredBid,
    expiredBid + 30,
    expiredBid + 60,
    expiredBid + 90,
  ],
  agentKey,
);
blockTimestamp = BigInt(expiredBid + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "expireIssue",
  [expiredIssue],
  competingAgentKey,
);
check(
  "expired work releases every reserved token",
  await read("AgentPoolV439CandidateRewardPool", pool, "totalReserved"),
  0n,
);

blockTimestamp += 86_400n;
const rejectedIssue = keccak256(toBytes("v439:rejected"));
const rejectedArtifact = keccak256(
  toBytes("rejected-candidate-artifact"),
);
const rejectedPatch = keccak256(toBytes("rejected-candidate-patch"));
const rejectedPlan = keccak256(toBytes("rejected-plan"));
const rejectedPlanSalt = keccak256(toBytes("rejected-plan-salt"));
const rejectedEvidence = keccak256(
  toBytes("candidate-fails-objective-replay"),
);
const rejectedValidationSalt = keccak256(
  toBytes("rejected-validation-salt"),
);
const rejectedBidDeadline = Number(blockTimestamp + 30n);
const rejectedDeliveryDeadline = rejectedBidDeadline + 30;
const rejectedCommitDeadline = rejectedDeliveryDeadline + 30;
const rejectedRevealDeadline = rejectedCommitDeadline + 30;
const rejectedPlanCommitment = await read(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "candidatePlanCommitment",
  [rejectedIssue, agent, rejectedPlan, rejectedPlanSalt],
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "openIssue",
  [
    rejectedIssue,
    keccak256(toBytes("rejected-issue-digest")),
    sourceSnapshot,
    acceptanceDigest,
    parseEther("3"),
    parseEther("0.5"),
    rejectedBidDeadline,
    rejectedDeliveryDeadline,
    rejectedCommitDeadline,
    rejectedRevealDeadline,
  ],
  agentKey,
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "submitCandidateBid",
  [rejectedIssue, parseEther("1"), rejectedPlanCommitment],
  agentKey,
);
blockTimestamp = BigInt(rejectedBidDeadline + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "awardCandidate",
  [rejectedIssue],
  competingAgentKey,
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "deliverCandidate",
  [
    rejectedIssue,
    rejectedPlan,
    rejectedPlanSalt,
    rejectedArtifact,
    rejectedPatch,
  ],
  agentKey,
);
const rejectedCommitment = await read(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "validationCommitment",
  [
    rejectedIssue,
    competingAgent,
    rejectedArtifact,
    2_000,
    rejectedEvidence,
    rejectedValidationSalt,
  ],
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "commitValidation",
  [rejectedIssue, rejectedCommitment, parseEther("0.5")],
  competingAgentKey,
);
blockTimestamp = BigInt(rejectedCommitDeadline + 1);
await expectRevert("a validator cannot reveal a different score", () =>
  write(
    "AgentPoolV439CandidateRewardPool",
    pool,
    "revealValidation",
    [
      rejectedIssue,
      9_500,
      rejectedEvidence,
      rejectedValidationSalt,
    ],
    competingAgentKey,
  ),
);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "revealValidation",
  [
    rejectedIssue,
    2_000,
    rejectedEvidence,
    rejectedValidationSalt,
  ],
  competingAgentKey,
);
blockTimestamp = BigInt(rejectedRevealDeadline + 1);
await write(
  "AgentPoolV439CandidateRewardPool",
  pool,
  "finalizeIssue",
  [rejectedIssue],
  competingAgentKey,
);
check(
  "a rejected candidate pays neither reporter nor implementer",
  await read("MockV43Token", token, "balanceOf", [agent]),
  parseEther("3.5"),
);
check(
  "valid negative validation work still receives its quoted fee",
  await read("MockV43Token", token, "balanceOf", [competingAgent]),
  parseEther("0.5"),
);
check(
  "a rejected artifact never becomes proven",
  await read(
    "AgentPoolV439CandidateRewardPool",
    pool,
    "provenArtifact",
    [rejectedArtifact],
  ),
  false,
);
check(
  "rejected settlement also releases unused reservation",
  await read("AgentPoolV439CandidateRewardPool", pool, "totalReserved"),
  0n,
);

const report = {
  ok: checks.every(({ passed }) => passed),
  transactions: transactionCount,
  checks,
  payout: {
    reporterApool: "0.5",
    implementerApool: "2",
    validatorApool: "1",
    totalApool: "3.5",
  },
  properties: {
    chainId: 84_532,
    finitePrefunded: true,
    createsWorkPower: false,
    canRecommendRelease: false,
    canMint: false,
    sameAgentRolesAllowed: true,
  },
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v439-candidate-reward-rehearsal.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    ok: report.ok,
    transactions: transactionCount,
    checks: checks.length,
  })}\n`,
);
