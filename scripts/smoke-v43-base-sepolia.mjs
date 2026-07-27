import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const manifestPath = path.join(root, "deployments", "84532.v43.4.json");
const evidencePath = path.join(
  root,
  "outputs",
  "v43.4-base-sepolia-economic-smoke.json",
);
const publicEvidencePath = path.join(
  root,
  "deployments",
  "84532.v43.4.smoke.json",
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 84532) throw new Error("V43_CHAIN_MISMATCH");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: baseSepolia, transport });
const roles = {
  coordinator: privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY")),
  resolver: privateKeyToAccount(
    process.env.V41_DEPLOYER_PRIVATE_KEY?.trim() ||
      requireEnv("DEPLOYER_PRIVATE_KEY"),
  ),
  worker: privateKeyToAccount(requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY")),
  externalWorker: privateKeyToAccount(
    requireEnv("TESTNET_AUTHOR_PRIVATE_KEY"),
  ),
  validator1: privateKeyToAccount(
    requireEnv("TESTNET_VALIDATOR_1_PRIVATE_KEY"),
  ),
  validator2: privateKeyToAccount(
    requireEnv("TESTNET_VALIDATOR_2_PRIVATE_KEY"),
  ),
  validator3: privateKeyToAccount(
    requireEnv("TESTNET_VALIDATOR_3_PRIVATE_KEY"),
  ),
};
const wallets = Object.fromEntries(
  Object.entries(roles).map(([name, account]) => [
    name,
    createWalletClient({
      account,
      chain: baseSepolia,
      transport,
    }),
  ]),
);

const contracts = manifest.contracts;
const abis = {
  token: artifact("AgentPoolV43Token").abi,
  market: artifact("AgentPoolV432TaskMarket").abi,
  capacity: artifact("AgentPoolV43CapacityRegistry").abi,
  proof: artifact("AgentPoolV432ProofRegistry").abi,
  issueGate: artifact("AgentPoolV432SystemIssueGate").abi,
  ledger: artifact("AgentPoolV43ContributionLedger").abi,
  registry: artifact("AgentPoolV43ReleaseRegistry").abi,
  consensus: artifact("AgentPoolV43EvolutionConsensus").abi,
  vault: artifact("AgentPoolV43EpochVault").abi,
};
const transactionHashes = [];
let gasUsed = 0n;

async function write(role, address, abi, functionName, args = []) {
  const account = roles[role];
  let request;
  let simulationError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      ({ request } = await client.simulateContract({
        account,
        address,
        abi,
        functionName,
        args,
      }));
      simulationError = undefined;
      break;
    } catch (error) {
      simulationError = error;
      if (attempt < 6) await sleep(attempt * 1_000);
    }
  }
  if (simulationError) throw simulationError;
  const hash = await wallets[role].writeContract(request);
  transactionHashes.push({ role, functionName, hash });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`${functionName}_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  return receipt;
}
async function read(address, abi, functionName, args = []) {
  return client.readContract({ address, abi, functionName, args });
}
function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}
function jobIdFor(creator, nonce, planHash) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [84532n, contracts.taskMarket, creator, nonce, planHash],
    ),
  );
}
function proofRoundId(jobId) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
      ["PROOF", jobId, 0],
    ),
  );
}
function proofCommitment(roundId, validator, scoreBps, evidenceHash, salt) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [roundId, validator, scoreBps, evidenceHash, salt],
    ),
  );
}
function expectedEvidence(specificationHash, deliveryHash, proof) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [specificationHash, deliveryHash, keccak256(proof)],
    ),
  );
}
function check(checks, name, actual, expected) {
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
async function publishAgent(role, group, runtime, capability) {
  const profile = await read(
    contracts.contributionLedger,
    abis.ledger,
    "profiles",
    [roles[role].address],
  );
  if (!profile[2]) {
    await write(
      role,
      contracts.contributionLedger,
      abis.ledger,
      "register",
      [group, runtime],
    );
  }
  const block = await client.getBlock();
  await write(
    role,
    contracts.capacityRegistry,
    abis.capacity,
    "publish",
    [capability, 32, Number(block.timestamp + 30n * 86_400n), runtime],
  );
}
async function findJobByPlan(planHash, creator = roles.coordinator.address) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > 1_800n ? latest - 1_800n : 0n;
  const logs = await client.getContractEvents({
    address: contracts.taskMarket,
    abi: abis.market,
    eventName: "JobCreated",
    fromBlock,
    toBlock: "latest",
  });
  const match = logs
    .filter(
      (entry) =>
        entry.args.planHash === planHash &&
        entry.args.creator?.toLowerCase() ===
          creator.toLowerCase(),
    )
    .at(-1);
  return match?.args.jobId;
}
async function mintedTo(recipient) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > 1_800n ? latest - 1_800n : 0n;
  const logs = await client.getContractEvents({
    address: contracts.token,
    abi: abis.token,
    eventName: "Transfer",
    args: {
      from: "0x0000000000000000000000000000000000000000",
      to: recipient,
    },
    fromBlock,
    toBlock: "latest",
  });
  return logs.reduce(
    (total, entry) => total + BigInt(entry.args.value ?? 0n),
    0n,
  );
}
async function waitForRead(readValue, predicate, label) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const value = await readValue();
    if (predicate(value)) return value;
    await sleep(attempt * 500);
  }
  throw new Error(`V43_CHAIN_STATE_NOT_VISIBLE:${label}`);
}
async function waitForJobState(jobId, allowedStates) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const job = await read(contracts.taskMarket, abis.market, "jobs", [jobId]);
    if (allowedStates.includes(Number(job[2]))) return job;
    await sleep(attempt * 500);
  }
  throw new Error(`V43_JOB_STATE_NOT_VISIBLE:${jobId}`);
}
async function waitForMilestoneState(jobId, allowedStates) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const milestone = await read(
      contracts.taskMarket,
      abis.market,
      "milestones",
      [jobId, 0],
    );
    if (allowedStates.includes(Number(milestone[16]))) return milestone;
    await sleep(attempt * 500);
  }
  throw new Error(`V43_MILESTONE_STATE_NOT_VISIBLE:${jobId}`);
}

if ((await client.getChainId()) !== 84532) {
  throw new Error("V43_RPC_NOT_BASE_SEPOLIA");
}
for (let index = 0; index < 3; index++) {
  const expected = manifest.bootstrapValidators[index].address.toLowerCase();
  const actual = roles[`validator${index + 1}`].address.toLowerCase();
  if (actual !== expected) {
    throw new Error(`V432_VALIDATOR_KEY_MISMATCH:${index + 1}`);
  }
}
main: {
  const existingEvidence = fs.existsSync(evidencePath)
    ? JSON.parse(fs.readFileSync(evidencePath, "utf8"))
    : null;
  if (
    existingEvidence?.ok &&
    existingEvidence.checks?.some(
      (entry) =>
        entry.name === "keeper receives precommitted payout" &&
        entry.passed,
    )
  ) {
  fs.writeFileSync(
    publicEvidencePath,
    `${JSON.stringify(existingEvidence, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      reused: true,
      evidencePath,
      systemJobId: existingEvidence.systemJob.jobId,
      externalJobId: existingEvidence.externalJob.jobId,
    })}\n`,
  );
    break main;
  }

const checks = [];
const capability = keccak256(toBytes("agentpool-system-improvement"));
await publishAgent(
  "worker",
  keccak256(toBytes("codex-pilot")),
  keccak256(toBytes("codex-v43-base-sepolia-runtime")),
  capability,
);
await publishAgent(
  "externalWorker",
  keccak256(toBytes("external-worker-pilot")),
  keccak256(toBytes("external-v43-base-sepolia-runtime")),
  capability,
);
await publishAgent(
  "coordinator",
  keccak256(toBytes("bootstrap-coordinator")),
  keccak256(toBytes("coordinator-v432-base-sepolia-runtime")),
  capability,
);
for (let index = 0; index < 3; index++) {
  const role = `validator${index + 1}`;
  const record = manifest.bootstrapValidators[index];
  const validatorProfile = await read(
    contracts.contributionLedger,
    abis.ledger,
    "profiles",
    [roles[role].address],
  );
  if (!validatorProfile[2]) {
    await write(
      role,
      contracts.contributionLedger,
      abis.ledger,
      "register",
      [
        record.group,
        keccak256(toBytes(`${role}-v432-base-sepolia-runtime`)),
      ],
    );
  }
}

const genesisRelease = manifest.genesisRelease;
const bootstrapIssueRecord = manifest.bootstrapIssues[0];
const { proof: bootstrapProof, ...bootstrapIssueManifest } =
  bootstrapIssueRecord;
const bootstrapIssue = {
  ...bootstrapIssueManifest,
  candidateBudgetCap: BigInt(bootstrapIssueRecord.candidateBudgetCap),
  totalBudgetCap: BigInt(bootstrapIssueRecord.totalBudgetCap),
};
const systemPlanHash = keccak256(toBytes("v43-system-improvement-smoke-plan"));
const systemSpecHash = bootstrapIssue.specificationHash;
const systemDeliveryHash = manifest.bootstrapObjective.deliveryHash;
const systemProof = manifest.bootstrapObjective.proof;
const systemEvidenceHash = bootstrapIssue.expectedEvidenceHash;
const systemRecipients = [
  roles.worker.address,
  roles.validator1.address,
  roles.validator2.address,
  roles.validator3.address,
];
const systemAmounts = [
  parseEther("80"),
  parseEther("10"),
  parseEther("10"),
  parseEther("10"),
];
const systemBudget = parseEther("120");
const systemNonce = await read(
  contracts.taskMarket,
  abis.market,
  "nextJobNonce",
);
let systemJobId =
  (await findJobByPlan(systemPlanHash)) ??
  jobIdFor(
    roles.coordinator.address,
    systemNonce,
    systemPlanHash,
  );
const systemTerms = [
  {
    worker: roles.worker.address,
    verifier: contracts.objectiveVerifier,
    capability,
    specificationHash: systemSpecHash,
    expectedEvidenceHash: systemEvidenceHash,
    payoutRoot: payoutRoot(systemRecipients, systemAmounts),
    allocation: parseEther("110"),
    workerBond: 0n,
    keeperFee: parseEther("10"),
    deadline: Number((await client.getBlock()).timestamp + 86_400n),
    capacityUnits: 4,
    minimumReveals: 3,
    passScoreBps: 8_000,
    commitWindow: 60,
    revealWindow: 60,
  },
];
const systemPolicies = [
  {
    validatorRoot: bootstrapIssue.validatorRoot,
    minimumOperatorGroups: 3,
  },
];
let systemJobState = await read(
  contracts.taskMarket,
  abis.market,
  "jobs",
  [systemJobId],
);
if (Number(systemJobState[2]) === 0) {
  await write(
    "coordinator",
    contracts.taskMarket,
    abis.market,
    "createSystemJobV2",
    [
      3,
      systemBudget,
      systemPlanHash,
      genesisRelease,
      bootstrapIssue,
      bootstrapProof,
      systemTerms,
      systemPolicies,
      [0],
      [[]],
    ],
  );
  await waitForJobState(systemJobId, [1]);
}
let systemMilestone = await read(
  contracts.taskMarket,
  abis.market,
  "milestones",
  [systemJobId, 0],
);
if (Number(systemMilestone[16]) === 1) {
  await write(
    "worker",
    contracts.taskMarket,
    abis.market,
    "acceptMilestone",
    [systemJobId, 0],
  );
  systemMilestone = await waitForMilestoneState(systemJobId, [2]);
}
if (Number(systemMilestone[16]) === 2) {
  await write(
    "worker",
    contracts.taskMarket,
    abis.market,
    "deliver",
    [systemJobId, 0, systemDeliveryHash],
  );
  await waitForMilestoneState(systemJobId, [3]);
}

const roundId = proofRoundId(systemJobId);
const scoreBps = 9_500;
const validatorEvidence = Array.from({ length: 3 }, (_, index) =>
  keccak256(toBytes(`independent-validator-evidence-v432-${index + 1}`)),
);
const validatorSalts = Array.from({ length: 3 }, (_, index) =>
  keccak256(toBytes(`validator-salt-v432-${index + 1}`)),
);
for (let index = 0; index < 3; index++) {
  const role = `validator${index + 1}`;
  const priorEvaluation = await read(
    contracts.proofRegistry,
    abis.proof,
    "evaluations",
    [roundId, roles[role].address],
  );
  if (priorEvaluation[0] === `0x${"0".repeat(64)}`) {
    await write(
      role,
      contracts.proofRegistry,
      abis.proof,
      "commitWithProof",
      [
        roundId,
        proofCommitment(
          roundId,
          roles[role].address,
          scoreBps,
          validatorEvidence[index],
          validatorSalts[index],
        ),
        manifest.bootstrapValidators[index].proof,
      ],
    );
  }
}
const round = await read(contracts.proofRegistry, abis.proof, "rounds", [
  roundId,
]);
const commitDeadline = Number(round[0]);
const revealDeadline = Number(round[1]);
const nowAfterCommit = Math.floor(Date.now() / 1_000);
if (commitDeadline >= nowAfterCommit) {
  await sleep((commitDeadline - nowAfterCommit + 2) * 1_000);
}
for (let index = 0; index < 3; index++) {
  const role = `validator${index + 1}`;
  const evaluationAfterCommit = await read(
    contracts.proofRegistry,
    abis.proof,
    "evaluations",
    [roundId, roles[role].address],
  );
  if (!evaluationAfterCommit[3]) {
    await write(
      role,
      contracts.proofRegistry,
      abis.proof,
      "reveal",
      [
        roundId,
        scoreBps,
        validatorEvidence[index],
        validatorSalts[index],
      ],
    );
  }
}
const nowAfterReveal = Math.floor(Date.now() / 1_000);
if (revealDeadline >= nowAfterReveal) {
  await sleep((revealDeadline - nowAfterReveal + 2) * 1_000);
}
systemJobState = await read(contracts.taskMarket, abis.market, "jobs", [
  systemJobId,
]);
if (Number(systemJobState[2]) === 2) {
  await write(
    "resolver",
    contracts.taskMarket,
    abis.market,
    "resolve",
    [systemJobId, 0, systemProof, systemRecipients, systemAmounts],
  );
  await waitForJobState(systemJobId, [4]);
}

const supplyAfterSystem = await waitForRead(
  () => read(contracts.token, abis.token, "totalSupply"),
  (value) => value >= parseEther("120"),
  "system-supply",
);
check(
  checks,
  "system mints only settled payouts",
  supplyAfterSystem,
  parseEther("120"),
);
check(
  checks,
  "system worker receives precommitted payout",
  await mintedTo(roles.worker.address),
  parseEther("80"),
);
for (let index = 0; index < 3; index++) {
  check(
    checks,
    `validator ${index + 1} receives precommitted payout`,
    await mintedTo(roles[`validator${index + 1}`].address),
    parseEther("10"),
  );
}
check(
  checks,
  "keeper receives precommitted payout",
  await mintedTo(roles.resolver.address),
  parseEther("10"),
);

const candidateReceiptId = keccak256(
  toBytes("v43-base-sepolia-candidate-receipt"),
);
const candidateRelease = keccak256(
  toBytes("agentpool-v4.3-base-sepolia-candidate"),
);
const candidateModuleHash = keccak256(
  toBytes("v43-agent-discovery-candidate-module"),
);
const candidateManifestHash = keccak256(
  toBytes("v43-agent-discovery-candidate-manifest"),
);
const canary = {
  qualityBps: 9_500,
  baselineQualityBps: 9_200,
  cost: 900,
  baselineCost: 1_000,
  latency: 1_000,
  baselineLatency: 1_000,
  securityRegressions: 0,
};
let candidateUsable = await read(
  contracts.releaseRegistry,
  abis.registry,
  "isUsable",
  [candidateRelease],
);
if (!candidateUsable) {
  const candidateMilestone = await read(
    contracts.taskMarket,
    abis.market,
    "milestones",
    [systemJobId, 0],
  );
  if (!candidateMilestone[17]) {
    await write(
      "worker",
      contracts.taskMarket,
      abis.market,
      "attestCandidate",
      [
        systemJobId,
        0,
        candidateReceiptId,
        candidateModuleHash,
        candidateManifestHash,
        canary.qualityBps,
        canary.baselineQualityBps,
        canary.cost,
        canary.baselineCost,
        canary.latency,
        canary.baselineLatency,
        canary.securityRegressions,
      ],
    );
  }
  await write(
    "worker",
    contracts.evolutionConsensus,
    abis.consensus,
    "proveRelease",
    [
      candidateReceiptId,
      genesisRelease,
      candidateRelease,
      candidateModuleHash,
      candidateManifestHash,
      manifest.financeInvariantHash,
      canary,
    ],
  );
  candidateUsable = await waitForRead(
    () =>
      read(contracts.releaseRegistry, abis.registry, "isUsable", [
        candidateRelease,
      ]),
    (value) => value === true,
    "candidate-release",
  );
}
check(
  checks,
  "bootstrap candidate is opt-in usable",
  await read(contracts.releaseRegistry, abis.registry, "isUsable", [
    candidateRelease,
  ]),
  true,
);
check(
  checks,
  "bootstrap candidate cannot replace recommendation",
  await read(
    contracts.releaseRegistry,
    abis.registry,
    "recommendedRelease",
  ),
  genesisRelease,
);

const externalPlanHash = keccak256(toBytes("v43-external-job-smoke-plan"));
const externalSpecHash = keccak256(
  toBytes("normalize-and-validate-agent-catalog"),
);
const externalDeliveryHash = keccak256(
  toBytes("v43-external-job-smoke-delivery"),
);
const externalProof = toHex("agentpool-v43-objective-external-proof");
const externalRecipients = [
  roles.externalWorker.address,
  roles.validator1.address,
];
const externalAmounts = [parseEther("23"), parseEther("3")];
const externalBudget = parseEther("30");
const externalNonce = await read(
  contracts.taskMarket,
  abis.market,
  "nextJobNonce",
);
let externalJobId =
  (await findJobByPlan(externalPlanHash, roles.worker.address)) ??
  jobIdFor(roles.worker.address, externalNonce, externalPlanHash);
const externalTerms = [
  {
    worker: roles.externalWorker.address,
    verifier: contracts.objectiveVerifier,
    capability,
    specificationHash: externalSpecHash,
    expectedEvidenceHash: expectedEvidence(
      externalSpecHash,
      externalDeliveryHash,
      externalProof,
    ),
    payoutRoot: payoutRoot(externalRecipients, externalAmounts),
    allocation: parseEther("26"),
    workerBond: 0n,
    keeperFee: parseEther("4"),
    deadline: Number((await client.getBlock()).timestamp + 86_400n),
    capacityUnits: 3,
    minimumReveals: 0,
    passScoreBps: 0,
    commitWindow: 0,
    revealWindow: 0,
  },
];
const externalPolicies = [
  {
    validatorRoot: `0x${"00".repeat(32)}`,
    minimumOperatorGroups: 0,
  },
];
const supplyBeforeExternal = await read(
  contracts.token,
  abis.token,
  "totalSupply",
);
let externalJobState = await read(
  contracts.taskMarket,
  abis.market,
  "jobs",
  [externalJobId],
);
if (Number(externalJobState[2]) === 0) {
  await write(
    "worker",
    contracts.token,
    abis.token,
    "approve",
    [contracts.userEscrow, externalBudget],
  );
  await write(
    "worker",
    contracts.taskMarket,
    abis.market,
    "createExternalJobV2",
    [
      externalBudget,
      externalPlanHash,
      genesisRelease,
      externalTerms,
      externalPolicies,
      [0],
    ],
  );
  await waitForJobState(externalJobId, [1]);
}
let externalMilestone = await read(
  contracts.taskMarket,
  abis.market,
  "milestones",
  [externalJobId, 0],
);
if (Number(externalMilestone[16]) === 1) {
  await write(
    "externalWorker",
    contracts.taskMarket,
    abis.market,
    "acceptMilestone",
    [externalJobId, 0],
  );
  externalMilestone = await waitForMilestoneState(externalJobId, [2]);
}
if (Number(externalMilestone[16]) === 2) {
  await write(
    "externalWorker",
    contracts.taskMarket,
    abis.market,
    "deliver",
    [externalJobId, 0, externalDeliveryHash],
  );
  await waitForMilestoneState(externalJobId, [3]);
}
externalJobState = await read(contracts.taskMarket, abis.market, "jobs", [
  externalJobId,
]);
if (Number(externalJobState[2]) === 2) {
  await write(
    "resolver",
    contracts.taskMarket,
    abis.market,
    "resolve",
    [
      externalJobId,
      0,
      externalProof,
      externalRecipients,
      externalAmounts,
    ],
  );
  await waitForJobState(externalJobId, [4]);
}
const supplyAfterExternal = await read(
  contracts.token,
  abis.token,
  "totalSupply",
);
check(
  checks,
  "external buyer work never mints",
  supplyAfterExternal,
  supplyBeforeExternal,
);
check(
  checks,
  "external worker receives buyer funds",
  await read(contracts.token, abis.token, "balanceOf", [
    roles.externalWorker.address,
  ]),
  parseEther("23"),
);
const externalJob = await read(contracts.taskMarket, abis.market, "jobs", [
  externalJobId,
]);
check(checks, "external job settles", externalJob[2], 4);
const systemJob = await read(contracts.taskMarket, abis.market, "jobs", [
  systemJobId,
]);
check(checks, "system improvement job settles", systemJob[2], 4);
check(
  checks,
  "validator evidence round becomes ready",
  await read(contracts.proofRegistry, abis.proof, "roundReady", [roundId]),
  true,
);
check(
  checks,
  "validator evidence score is recorded",
  await read(contracts.proofRegistry, abis.proof, "medianScore", [roundId]),
  scoreBps,
);
check(
  checks,
  "validator evidence spans three operator groups",
  await read(contracts.proofRegistry, abis.proof, "groupCount", [roundId]),
  3,
);
const bootstrapUsage = await read(
  contracts.systemIssueGate,
  abis.issueGate,
  "usage",
  [bootstrapIssue.issueId],
);
check(
  checks,
  "the sole BOOTSTRAP system issue is fully consumed",
  bootstrapUsage[2],
  1,
);

const report = {
  ok: checks.every((entry) => entry.passed),
  chainId: 84532,
  network: "Base Sepolia",
  phase: "BOOTSTRAP",
  contracts,
  roles: Object.fromEntries(
    Object.entries(roles).map(([name, account]) => [name, account.address]),
  ),
  systemJob: {
    jobId: systemJobId,
    funding: "EVOLUTION",
    budgetApool: "120",
    paidApool: "120",
    candidateRelease,
    proofRoundId: roundId,
  },
  externalJob: {
    jobId: externalJobId,
    funding: "EXTERNAL",
    budgetApool: "30",
    paidApool: "30",
    newEmissionApool: "0",
  },
  totalSupplyApool: formatUnits(supplyAfterExternal, 18),
  gasUsed: gasUsed.toString(),
  transactionHashes,
  checks,
  completedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(
  publicEvidencePath,
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `${JSON.stringify({
    ok: report.ok,
    evidencePath,
    systemJobId,
    externalJobId,
    transactions: transactionHashes.length,
    gasUsed: gasUsed.toString(),
    totalSupplyApool: report.totalSupplyApool,
    coordinatorRemainingTestEth: formatEther(
      await client.getBalance({ address: roles.coordinator.address }),
    ),
    resolverRemainingTestEth: formatEther(
      await client.getBalance({ address: roles.resolver.address }),
    ),
  })}\n`,
);
}
