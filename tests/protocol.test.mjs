import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("APOOL is a fixed one-trillion whole-unit supply with declared allocations", async () => {
  const token = await source("contracts/AgentPoolToken.sol");
  const allocations = [
    400_000_000_000n,
    200_000_000_000n,
    100_000_000_000n,
    60_000_000_000n,
    40_000_000_000n,
    100_000_000_000n,
    50_000_000_000n,
    50_000_000_000n,
  ];
  assert.equal(allocations.reduce((sum, value) => sum + value, 0n), 1_000_000_000_000n);
  assert.match(token, /MAX_SUPPLY = 1_000_000_000_000/);
  for (const allocation of allocations) {
    assert.match(token, new RegExp(allocation.toLocaleString("en-US").replaceAll(",", "_")));
  }
  assert.match(token, /function decimals\(\) public pure override returns \(uint8\)/);
  assert.match(token, /return 0/);
  assert.match(token, /ERC20Burnable/);
  assert.doesNotMatch(token, /function\s+mint\s*\(/);
  assert.match(token, /assert\(totalSupply\(\) == MAX_SUPPLY\)/);
});

test("single and project work use fixed verifier fees with 90/0/10 settlement", async () => {
  const [job, project, registry] = await Promise.all([
    source("contracts/AgentPoolJobEscrow.sol"),
    source("contracts/AgentPoolProjectEscrow.sol"),
    source("contracts/AgentPoolRegistry.sol"),
  ]);
  for (const contract of [job, project]) {
    assert.match(contract, /VALIDATOR_SHARE_BPS = 9_000/);
    assert.match(contract, /BURN_SHARE_BPS = 0/);
    assert.match(contract, /SECURITY_SHARE_BPS = 1_000/);
    assert.match(contract, /registry\.validationFeeForVerifier\(verifierId\)/);
    assert.doesNotMatch(contract, /VALIDATION_FEE_BPS|burnableApool|\.burn\(/);
  }
  assert.match(registry, /validationFeeApool < 10/);
  assert.match(registry, /validationFeeApool > 30/);
  assert.match(registry, /validationFeeApool % 10 != 0/);
  assert.match(job, /SELLER_BOND_BPS = 1_000/);
  assert.match(job, /MIN_VERIFIED_JOB_PRICE = 1_000/);
  assert.match(job, /DISPUTE_FEE = 50/);
  assert.match(job, /sellerBond < sellerBondFor\(price\)/);
  assert.match(project, /WORKER_BOND_BPS = 1_000/);
  assert.match(project, /MIN_VERIFIED_TASK_PRICE = 1_000/);
  assert.match(project, /MAX_VALIDATION_FEE = 30/);
  assert.match(project, /workerBondFor\(price\)/);
  assert.match(job, /PROTOCOL_FEE_BPS = 0/);
  assert.doesNotMatch(job, /setProtocolFee|protocolTreasury/);
  assert.match(job, /uint256\(job\.price\) \+ job\.sellerBond/);
  assert.match(job, /uint256\(job\.price\) \+ job\.validationFee/);
  assert.match(job, /Outcome\.AMBIGUOUS/);
  assert.match(job, /RESOLUTION_GRACE = 3 days/);
  assert.match(job, /refundStalledSubmission/);
  assert.match(job, /uint256\(job\.price\) \+ job\.validationFee \+ job\.challengeBond/);
  assert.doesNotMatch(job, /refundExpired[\s\S]*msg\.sender != job\.buyer/);
});

test("benchmark mining requires exact 3-of-5 receipts and enforces independent caps", async () => {
  const vault = await source("contracts/AgentPoolBenchmarkRewardVault.sol");
  assert.match(vault, /VALIDATOR_COUNT = 5/);
  assert.match(vault, /VALIDATOR_QUORUM = 3/);
  assert.match(vault, /signatures\.length != VALIDATOR_QUORUM/);
  assert.match(vault, /claimedChallenge\[receipt\.challengeId\]/);
  assert.match(vault, /ACCOUNT_DAILY_CAP_BPS = 50/);
  assert.match(vault, /TRACK_CODE/);
  assert.match(vault, /TRACK_DATA/);
  assert.match(vault, /TRACK_MATH/);
  assert.match(vault, /LEAGUE_CONTAINER/);
  assert.match(vault, /LEAGUE_API/);
  assert.match(vault, /ANNUAL_DECAY_BPS = 1_500/);
  assert.match(vault, /REWARD_YEARS = 10/);
  assert.match(vault, /accuracyBps\) \+ receipt\.efficiencyBps/);
  assert.doesNotMatch(vault, /function\s+mint\s*\(/);
});

test("multi-agent projects conserve signed budgets and stage worker payouts", async () => {
  const [escrow, resolver] = await Promise.all([
    source("contracts/AgentPoolProjectEscrow.sol"),
    source("contracts/AgentPoolProjectResolver.sol"),
  ]);
  assert.match(escrow, /MAX_TASKS = 32/);
  assert.match(escrow, /STAGE_PAYMENT_BPS = 8_000/);
  assert.match(escrow, /project\.committedWorker.*project\.maxWorkerBudget/s);
  assert.match(escrow, /project\.committedFees.*project\.validationReserve/s);
  assert.match(escrow, /uint256\(maxTasks\) \* MAX_VALIDATION_FEE/);
  assert.match(escrow, /maxWorkerBudget < uint256\(maxTasks\) \* MIN_VERIFIED_TASK_PRICE/);
  assert.match(escrow, /function approvePlan/);
  assert.match(escrow, /MerkleProof\.verifyCalldata/);
  assert.match(escrow, /consumedPlanLeaf\[projectId\]\[leaf\]/);
  assert.match(escrow, /tasks\[dependencies\[index\]\]\.state != TaskState\.PASSED/);
  assert.match(escrow, /project\.taskCount != project\.plannedTaskCount/);
  assert.match(escrow, /project\.workerCount < project\.minWorkers/);
  assert.match(escrow, /project\.workerFundsRemaining -= stagePayment/);
  assert.match(escrow, /project\.workerFundsRemaining -= holdback/);
  assert.match(escrow, /uint256\(project\.workerFundsRemaining\) \+ project\.feeFundsRemaining/);
  assert.match(resolver, /VALIDATOR_QUORUM = 3/);
  assert.match(resolver, /consumedReceipt\[digest\]/);
  assert.match(resolver, /projectEscrow\.resolveTask/);
});

test("verifier identities are versioned and validation outages fail to refunds", async () => {
  const [registry, oracle, job] = await Promise.all([
    source("contracts/AgentPoolRegistry.sol"),
    source("contracts/AgentPoolWorkOracle.sol"),
    source("contracts/AgentPoolJobEscrow.sol"),
  ]);
  assert.match(registry, /VerifierAlreadyRegistered/);
  assert.match(registry, /function setVerifierActive/);
  assert.match(oracle, /SELECTION_TIMEOUT = 24 hours/);
  assert.match(oracle, /function finalizeUnselected/);
  assert.match(oracle, /_resolveUnavailable/);
  assert.match(job, /apool\.safeTransfer\(job\.buyer, uint256\(job\.price\) \+ job\.validationFee\)/);
  assert.match(job, /apool\.safeTransfer\(job\.seller, job\.sellerBond\)/);
});

test("API routes keep mining, production, and chain authority separate", async () => {
  const [listing, jobState, tracks, worker] = await Promise.all([
    source("app/api/v1/listings/route.ts"),
    source("app/api/v1/jobs/[id]/route.ts"),
    source("app/api/v2/mining/tracks/route.ts"),
    source("worker/index.ts"),
  ]);
  assert.match(listing, /benchmarkMiningEligible: false/);
  assert.match(listing, /\n\s+0,\n\s+now,/);
  assert.match(jobState, /CHAIN_STATE_AUTHORITATIVE/);
  assert.doesNotMatch(jobState, /UPDATE jobs SET state/);
  assert.match(tracks, /marketplaceOrdersEarnMiningRewards: false/);
  assert.match(tracks, /tokenTradesEarnMiningRewards: false/);
  assert.match(worker, /benchmarkMining: true/);
  assert.match(worker, /multiAgentProjects: true/);
  assert.match(worker, /validationPricing: "fixed-by-verifier"/);
  assert.match(worker, /validators: 9000/);
  assert.match(worker, /burn: 0/);
});

test("open beta discovery is public, testnet-only, and ships a mainnet-refusing reference miner", async () => {
  const [status, skill, worker, miner] = await Promise.all([
    source("app/api/v2/status/route.ts"),
    source("app/skill.md/route.ts"),
    source("worker/index.ts"),
    source("public/open-beta-miner.mjs"),
  ]);
  assert.match(status, /phase:\s*"open"/);
  assert.match(status, /applicationsRequired:\s*false/);
  assert.match(skill, /No application or allowlist is required/);
  assert.match(worker, /referenceAgent/);
  assert.match(miner, /chainId !== 84532/);
  assert.match(miner, /NEVER SEND REAL ASSETS/);
  assert.match(miner, /validatorSignatures\?\.length !== 3/);
  assert.match(miner, /OPEN BETA PASS/);
});

test("every state-creating API requires replay protection", async () => {
  const routes = [
    "app/api/v1/agents/route.ts",
    "app/api/v1/artifacts/route.ts",
    "app/api/v1/jobs/route.ts",
    "app/api/v1/listings/route.ts",
    "app/api/v2/mining/submissions/route.ts",
    "app/api/v2/mining/sessions/route.ts",
    "app/api/v2/chain/backfill/route.ts",
    "app/api/v2/projects/route.ts",
    "app/api/v2/projects/[id]/tasks/route.ts",
  ];
  for (const route of routes) {
    const body = await source(route);
    assert.match(body, /requireIdempotencyKey\(request\)/, `${route} does not require a key`);
    assert.match(body, /readIdempotentResponse/, `${route} does not replay responses`);
    assert.match(body, /storeIdempotentResponse/, `${route} does not store responses`);
  }
});

test("founder allocation is vested and bootstrap governance is timelocked", async () => {
  const [vesting, deploy] = await Promise.all([
    source("contracts/AgentPoolFounderVesting.sol"),
    source("scripts/deploy.mjs"),
  ]);
  assert.match(vesting, /CLIFF_DURATION = 365 days/);
  assert.match(vesting, /VESTING_DURATION = 4 \* 365 days/);
  assert.match(deploy, /GOVERNANCE_MULTISIG/);
  assert.match(deploy, /7n \* 24n \* 60n \* 60n/);
  assert.doesNotMatch(deploy, /deploy\("AgentPoolGovernor"/);
});

test("mainnet deployment remains fail-closed", async () => {
  const [gates, deploy, preflight] = await Promise.all([
    source("mainnet-gates.json").then(JSON.parse),
    source("scripts/deploy.mjs"),
    source("scripts/preflight-deploy.mjs"),
  ]);
  assert.equal(gates.version, 2);
  assert.ok(Object.values(gates.gates).every((gate) => gate.status === "blocked"));
  assert.ok(gates.gates.validatorCollateral);
  for (const script of [deploy, preflight]) {
    assert.match(script, /MAINNET_BLOCKED/);
    assert.match(script, /MAINNET_AUDIT_REPORT_SHA256/);
    assert.match(script, /CHAINLINK_VRF_ADAPTER/);
    assert.match(script, /MAINNET_VALIDATOR_ECONOMICS_SHA256/);
  }
  assert.match(preflight, /MAINNET_SAFE_INVALID/);
  assert.match(preflight, /FOUNDER_BENEFICIARY/);
  assert.match(preflight, /getOwners/);
  assert.match(preflight, /getThreshold/);
  assert.match(preflight, /must be exact 2-of-3/);
  assert.match(preflight, /MAINNET_SAFE_OWNER_SET_MISMATCH/);
});

test("obsolete weekly mining artifacts are removed and v3 bytecode is deployable", async () => {
  await assert.rejects(access(new URL("../contracts/AgentPoolMiningVault.sol", import.meta.url)));
  await assert.rejects(access(new URL("../mining-schedule.json", import.meta.url)));
  const required = [
    "AgentPoolToken",
    "AgentPoolBenchmarkRewardVault",
    "AgentPoolJobEscrow",
    "AgentPoolProjectEscrow",
    "AgentPoolProjectResolver",
  ];
  const files = await readdir(new URL("../artifacts/", import.meta.url));
  for (const name of required) {
    assert.ok(files.includes(`${name}.json`), `${name} artifact is missing`);
    const artifact = JSON.parse(await source(`artifacts/${name}.json`));
    assert.ok(artifact.bytecode.startsWith("0x") && artifact.bytecode.length > 100);
    assert.ok((artifact.deployedBytecode.length - 2) / 2 <= 24_576);
  }
});
