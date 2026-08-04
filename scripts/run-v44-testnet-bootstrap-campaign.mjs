import fs from "node:fs";
import path from "node:path";
import {
  encodeAbiParameters,
  formatUnits,
  keccak256,
  parseUnits,
  toBytes,
} from "viem";
import {
  bytes32,
  createV44TestnetParticipant,
  jobIdFor,
  payoutRoot,
  proofRoundId,
} from "./lib/v44-testnet-participant.mjs";

const ROOT = process.cwd();
const action =
  process.argv.find((entry) => entry.startsWith("--action="))?.slice(9) ??
  "status";
const allowedActions = new Set(["status", "prepare", "open", "advance", "run"]);
if (!allowedActions.has(action)) {
  throw new Error("V44_BOOTSTRAP_CAMPAIGN_ACTION_INVALID");
}
if (process.argv.includes("--mainnet") || Number(process.env.AGENTPOOL_CHAIN_ID ?? 84532) !== 84532) {
  throw new Error("V44_BOOTSTRAP_CAMPAIGN_BASE_SEPOLIA_ONLY");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`V44_BOOTSTRAP_CAMPAIGN_ENV_REQUIRED:${name}`);
  return value;
}

function loadPrivateCatalog(manifest, participant) {
  const filePath = path.resolve(
    requireEnv("V44_BOOTSTRAP_OBJECTIVES_FILE"),
  );
  if (!fs.existsSync(filePath)) {
    throw new Error("V44_BOOTSTRAP_CAMPAIGN_PRIVATE_CATALOG_MISSING");
  }
  const catalog = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    catalog.schema !== "agentpool.mainnet.v44.bootstrap-objectives/v1" ||
    catalog.campaignId !== manifest.campaignId ||
    catalog.mechanicsOnly !== false ||
    catalog.eligibleForReliability !== true ||
    !Array.isArray(catalog.objectives) ||
    catalog.objectives.length !== manifest.bootstrap.objectives.length ||
    catalog.objectives.some((objective, index) => {
      const committed = manifest.bootstrap.objectives[index];
      const delivery = participant.buildDelivery(index);
      return (
        objective.objectiveId === undefined ||
        !/^0x(?:[a-fA-F0-9]{2})+$/u.test(objective.objectiveProofHex ?? "") ||
        objective.capabilityHash.toLowerCase() !==
          committed.capabilityHash.toLowerCase() ||
        objective.specificationHash.toLowerCase() !==
          committed.specificationHash.toLowerCase() ||
        objective.deliveryHash.toLowerCase() !==
          delivery.deliveryHash.toLowerCase()
      );
    })
  ) {
    throw new Error("V44_BOOTSTRAP_CAMPAIGN_PRIVATE_CATALOG_INVALID");
  }
  return catalog;
}

function statePath(manifest) {
  return path.join(
    ROOT,
    "outputs",
    `v44-bootstrap-live.${manifest.campaignId}.local.json`,
  );
}

function readState(manifest) {
  const filePath = statePath(manifest);
  if (!fs.existsSync(filePath)) {
    return {
      schema: "agentpool.testnet.v44.bootstrap-live/v1",
      campaignId: manifest.campaignId,
      jobId: null,
      transactions: [],
      updatedAt: null,
    };
  }
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    state.schema !== "agentpool.testnet.v44.bootstrap-live/v1" ||
    state.campaignId !== manifest.campaignId ||
    !Array.isArray(state.transactions)
  ) {
    throw new Error("V44_BOOTSTRAP_CAMPAIGN_STATE_INVALID");
  }
  return state;
}

function saveState(manifest, state) {
  const filePath = statePath(manifest);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
  return next;
}

function record(state, role, actionName, receipt) {
  state.transactions.push({ role, action: actionName, ...receipt });
}

const proposer = createV44TestnetParticipant({
  privateKey: requireEnv("TESTNET_OPERATIONS_PRIVATE_KEY"),
});
const { manifest } = proposer;
const catalog = loadPrivateCatalog(manifest, proposer);
const validators = [1, 2, 3].map((index) =>
  createV44TestnetParticipant({
    privateKey: requireEnv(`TESTNET_VALIDATOR_${index}_PRIVATE_KEY`),
  }),
);
const worker = requireEnv("V44_BOOTSTRAP_WORKER");
if (!/^0x[a-fA-F0-9]{40}$/u.test(worker)) {
  throw new Error("V44_BOOTSTRAP_CAMPAIGN_WORKER_INVALID");
}
if (
  proposer.account.address.toLowerCase() !==
  manifest.bootstrap.issue.bootstrapProposer.toLowerCase()
) {
  throw new Error("V44_BOOTSTRAP_CAMPAIGN_PROPOSER_KEY_MISMATCH");
}
for (let index = 0; index < validators.length; index += 1) {
  if (
    validators[index].account.address.toLowerCase() !==
    manifest.bootstrap.validators[index].address.toLowerCase()
  ) {
    throw new Error(`V44_BOOTSTRAP_CAMPAIGN_VALIDATOR_KEY_MISMATCH:${index}`);
  }
}

async function ensureRegistered(client, group, runtime) {
  const profile = await client.read(
    manifest.contracts.contributionLedger,
    client.abis.ledger,
    "profiles",
    [client.account.address],
  );
  if (profile[2]) {
    if (
      profile[0].toLowerCase() !== group.toLowerCase() ||
      profile[1].toLowerCase() !== runtime.toLowerCase()
    ) {
      throw new Error("V44_BOOTSTRAP_CAMPAIGN_PROFILE_MISMATCH");
    }
    return null;
  }
  return client.register(group, runtime);
}

async function prepare(state) {
  const proposerGroup = bytes32(`v44:${manifest.campaignId}:bootstrap-proposer`);
  const proposerRuntime = bytes32("agentpool-v44-bootstrap-coordinator-v1");
  const proposerReceipt = await ensureRegistered(
    proposer,
    proposerGroup,
    proposerRuntime,
  );
  if (proposerReceipt) record(state, "PROPOSER", "REGISTER", proposerReceipt);
  for (let index = 0; index < validators.length; index += 1) {
    const validatorReceipt = await ensureRegistered(
      validators[index],
      manifest.bootstrap.validators[index].group,
      bytes32(`agentpool-v44-bootstrap-validator-${index + 1}-v1`),
    );
    if (validatorReceipt) {
      record(state, `VALIDATOR_${index + 1}`, "REGISTER", validatorReceipt);
    }
  }
  const workerProfile = await proposer.read(
    manifest.contracts.contributionLedger,
    proposer.abis.ledger,
    "profiles",
    [worker],
  );
  const capabilities = [
    ...new Set(
      manifest.bootstrap.objectives.map((objective) => objective.capabilityHash),
    ),
  ];
  const offers = [];
  for (const capability of capabilities) {
    const offer = await proposer.read(
      manifest.contracts.capacityRegistry,
      proposer.abis.capacity,
      "offers",
      [worker, capability],
    );
    offers.push({
      capability,
      capacity: Number(offer[0]),
      held: Number(offer[1]),
      expiresAt: Number(offer[2]),
      runtimeHash: offer[3],
    });
  }
  return {
    proposerRegistered: true,
    validatorsRegistered: true,
    worker,
    workerRegistered: Boolean(workerProfile[2]),
    workerGroup: workerProfile[0],
    workerRuntime: workerProfile[1],
    capacityOffers: offers,
    workerReady:
      Boolean(workerProfile[2]) &&
      offers.every(
        (offer) =>
          offer.capacity - offer.held >= 100 &&
          offer.expiresAt > Math.floor(Date.now() / 1_000) + 3_600 &&
          offer.runtimeHash.toLowerCase() === workerProfile[1].toLowerCase(),
      ),
  };
}

function termsFor(workerAddress) {
  const allocation = parseUnits("4", 18);
  const keeperFee = parseUnits("1", 18);
  const deadline = Number(manifest.bootstrap.issue.expiresAt) - 86_400;
  const terms = manifest.bootstrap.objectives.map((objective) => ({
    worker: workerAddress,
    verifier: manifest.bootstrap.issue.verifier,
    capability: objective.capabilityHash,
    specificationHash: objective.specificationHash,
    expectedEvidenceHash: objective.expectedEvidenceHash,
    payoutRoot: payoutRoot([workerAddress], [allocation]),
    allocation,
    workerBond: 0n,
    keeperFee,
    deadline,
    capacityUnits: objective.capacityUnits,
    minimumReveals: manifest.bootstrap.issue.minimumReveals,
    passScoreBps: manifest.bootstrap.issue.passScoreBps,
    commitWindow: 60,
    revealWindow: 60,
  }));
  return {
    allocation,
    keeperFee,
    terms,
    policies: terms.map(() => ({
      validatorRoot: manifest.bootstrap.validatorRoot,
      minimumOperatorGroups: manifest.bootstrap.issue.minimumValidatorGroups,
    })),
    dependencies: terms.map((_, index) =>
      index === 0 ? 0 : Number((1n << BigInt(index)) - 1n),
    ),
    objectiveProofs: manifest.bootstrap.objectives.map(
      (objective) => objective.proof,
    ),
  };
}

async function open(state) {
  if (state.jobId) return { alreadyOpen: true, jobId: state.jobId };
  const readiness = await prepare(state);
  if (!readiness.workerReady) {
    throw new Error(`V44_BOOTSTRAP_CAMPAIGN_WORKER_NOT_READY:${JSON.stringify(readiness)}`);
  }
  const block = await proposer.client.getBlock();
  if (Number(block.timestamp) < Number(manifest.genesisStart)) {
    throw new Error(
      `V44_BOOTSTRAP_CAMPAIGN_GENESIS_NOT_STARTED:${Number(manifest.genesisStart) - Number(block.timestamp)}`,
    );
  }
  const planHash = keccak256(
    toBytes(`AGENTPOOL_V44:${manifest.campaignId}:bootstrap-plan`),
  );
  const nonce = await proposer.read(
    manifest.contracts.taskMarket,
    proposer.abis.market,
    "nextJobNonce",
  );
  const jobId = jobIdFor(
    manifest.contracts.taskMarket,
    proposer.account.address,
    nonce,
    planHash,
  );
  const plan = termsFor(worker);
  const receipt = await proposer.write(
    manifest.contracts.taskMarket,
    proposer.abis.market,
    "createSystemJobV2",
    [
      3,
      parseUnits("120", 18),
      planHash,
      manifest.genesisRelease,
      manifest.bootstrap.issue,
      [],
      plan.terms,
      plan.policies,
      plan.dependencies,
      plan.objectiveProofs,
    ],
  );
  state.jobId = jobId;
  state.worker = worker;
  state.planHash = planHash;
  record(state, "PROPOSER", "CREATE_SYSTEM_JOB", receipt);
  return { jobId, planHash, receipt };
}

function deterministicValidation(jobId, milestone, validatorAddress) {
  const label = `${manifest.campaignId}:${jobId}:${milestone}:${validatorAddress.toLowerCase()}`;
  return {
    scoreBps: 9_500,
    evidence: `v44-bootstrap-evidence:${label}`,
    salt: `v44-bootstrap-salt:${label}`,
  };
}

async function advance(state) {
  if (!state.jobId) return { state: "NOT_OPEN" };
  const job = await proposer.read(
    manifest.contracts.taskMarket,
    proposer.abis.market,
    "jobs",
    [state.jobId],
  );
  if (Number(job[2]) === 4) return { state: "SETTLED", jobId: state.jobId };
  const milestoneCount = Number(job[9]);
  for (let milestone = 0; milestone < milestoneCount; milestone += 1) {
    const current = await proposer.read(
      manifest.contracts.taskMarket,
      proposer.abis.market,
      "milestones",
      [state.jobId, milestone],
    );
    const milestoneState = Number(current[16]);
    if (milestoneState === 4) continue;
    if (milestoneState === 1) {
      return { state: "WAITING_FOR_WORKER_ACCEPT", jobId: state.jobId, milestone };
    }
    if (milestoneState === 2) {
      return { state: "WAITING_FOR_WORKER_DELIVERY", jobId: state.jobId, milestone };
    }
    if (milestoneState !== 3) {
      return { state: "TERMINAL_FAILURE", jobId: state.jobId, milestone, milestoneState };
    }
    const roundId = proofRoundId(state.jobId, milestone);
    const round = await proposer.read(
      manifest.contracts.proofRegistry,
      proposer.abis.proof,
      "rounds",
      [roundId],
    );
    const block = await proposer.client.getBlock();
    const now = Number(block.timestamp);
    const commits = [];
    if (now <= Number(round[0])) {
      for (let index = 0; index < validators.length; index += 1) {
        const evaluation = await proposer.read(
          manifest.contracts.proofRegistry,
          proposer.abis.proof,
          "evaluations",
          [roundId, validators[index].account.address],
        );
        if (evaluation[0] !== `0x${"0".repeat(64)}`) continue;
        const values = deterministicValidation(
          state.jobId,
          milestone,
          validators[index].account.address,
        );
        const receipt = await validators[index].commitEvaluation({
          jobId: state.jobId,
          milestone,
          ...values,
          proof: manifest.bootstrap.validators[index].proof,
        });
        record(state, `VALIDATOR_${index + 1}`, `COMMIT_${milestone}`, receipt);
        commits.push(receipt.transactionHash);
      }
      return {
        state: "COMMIT_WINDOW",
        jobId: state.jobId,
        milestone,
        commitDeadline: Number(round[0]),
        commits,
      };
    }
    const reveals = [];
    if (now <= Number(round[1])) {
      for (let index = 0; index < validators.length; index += 1) {
        const evaluation = await proposer.read(
          manifest.contracts.proofRegistry,
          proposer.abis.proof,
          "evaluations",
          [roundId, validators[index].account.address],
        );
        if (evaluation[4]) continue;
        if (evaluation[0] === `0x${"0".repeat(64)}`) {
          throw new Error(`V44_BOOTSTRAP_CAMPAIGN_COMMIT_MISSING:${milestone}:${index}`);
        }
        const values = deterministicValidation(
          state.jobId,
          milestone,
          validators[index].account.address,
        );
        const receipt = await validators[index].revealEvaluation({
          jobId: state.jobId,
          milestone,
          ...values,
        });
        record(state, `VALIDATOR_${index + 1}`, `REVEAL_${milestone}`, receipt);
        reveals.push(receipt.transactionHash);
      }
      return {
        state: "REVEAL_WINDOW",
        jobId: state.jobId,
        milestone,
        revealDeadline: Number(round[1]),
        reveals,
      };
    }
    const receipt = await proposer.resolve({
      jobId: state.jobId,
      milestone,
      objectiveProofHex: catalog.objectives[milestone].objectiveProofHex,
      recipients: [worker],
      amountsApool: ["4"],
    });
    record(state, "KEEPER", `RESOLVE_${milestone}`, receipt);
    return {
      state: "MILESTONE_SETTLED",
      jobId: state.jobId,
      milestone,
      receipt,
    };
  }
  return { state: "AWAITING_JOB_CLOSE", jobId: state.jobId };
}

async function summary(state) {
  const status = await proposer.status();
  const job = state.jobId
    ? await proposer.read(
        manifest.contracts.taskMarket,
        proposer.abis.market,
        "jobs",
        [state.jobId],
      )
    : null;
  return {
    campaignId: manifest.campaignId,
    sourceCommit: manifest.sourceCommit,
    genesisStart: manifest.genesisStart,
    secondsUntilGenesis: status.secondsUntilGenesis,
    jobId: state.jobId,
    jobState: job ? Number(job[2]) : 0,
    paidTapool: job ? formatUnits(job[7], 18) : "0",
    transactionCount: state.transactions.length,
    worker,
  };
}

let state = readState(manifest);
let output;
if (action === "prepare") {
  output = { ...(await prepare(state)), ...(await summary(state)) };
} else if (action === "open") {
  output = { ...(await open(state)), ...(await summary(state)) };
} else if (action === "advance") {
  output = { ...(await advance(state)), ...(await summary(state)) };
} else if (action === "run") {
  await open(state);
  const deadline = Date.now() + Number(process.env.V44_BOOTSTRAP_RUN_TIMEOUT_MS ?? 21_600_000);
  const outcomes = [];
  while (Date.now() < deadline) {
    const next = await advance(state);
    outcomes.push(next);
    state = saveState(manifest, state);
    if (next.state === "SETTLED" || next.state === "TERMINAL_FAILURE") break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  output = { outcomes, ...(await summary(state)) };
} else {
  output = await summary(state);
}
state = saveState(manifest, state);
process.stdout.write(`${JSON.stringify({ ok: true, action, ...output }, null, 2)}\n`);
