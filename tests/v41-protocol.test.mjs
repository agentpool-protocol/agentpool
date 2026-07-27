import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file) {
  return readFile(new URL(`../${file}`, import.meta.url), "utf8");
}

test("v4.1 token starts empty and only its one-time controller can mint", async () => {
  const token = await source("contracts/v4/AgentPoolV41Token.sol");
  assert.match(token, /MAX_SUPPLY = 1_000_000_000_000 ether/);
  assert.match(token, /emissionController/);
  assert.match(token, /totalSupply\(\) \+ amount > MAX_SUPPLY/);
  const constructorBody = token.slice(
    token.indexOf("constructor"),
    token.indexOf("function setEmissionController"),
  );
  assert.doesNotMatch(token, /Ownable/);
  assert.doesNotMatch(constructorBody, /_mint\(/);
  assert.match(token, /msg\.sender != emissionController/);
  assert.doesNotMatch(token, /burn\(/);
});

test("v4.1 controller caps capability, proof experiments, and one issue", async () => {
  const controller = await source("contracts/v4/AgentPoolV41EmissionController.sol");
  assert.match(controller, /CAPABILITY_CAP_BPS = 500/);
  assert.match(controller, /EXPERIMENT_CAP_BPS = 100/);
  assert.match(controller, /ISSUE_CAP_BPS = 1_000/);
  assert.match(controller, /GENESIS_DURATION = 180 days/);
  assert.match(controller, /HALF_LIFE = 8 \* 365 days/);
  assert.match(controller, /genesisCap = token_\.MAX_SUPPLY\(\) \/ 200/);
  assert.match(controller, /epochReserved/);
  assert.match(controller, /releaseReservationFromVault/);
  assert.doesNotMatch(
    controller,
    /onlyOwner|function\s+pause|function\s+emergencyWithdraw|delegatecall/,
  );
});

test("reserve settlement is fixed before work and evaluator cannot set payout", async () => {
  const vault = await source("contracts/v4/AgentPoolV41EpochVault.sol");
  assert.match(vault, /expectedEvidenceHash/);
  assert.match(vault, /payoutRoot/);
  assert.match(vault, /keccak256\(abi\.encode\(recipients, amounts\)\) != assignment\.payoutRoot/);
  assert.match(vault, /controller\.reserveFromVault\(reservedPayout\)/);
  assert.match(vault, /controller\.mintBatchFromVault\(recipients, amounts\)/);
  assert.match(vault, /controller\.releaseReservationFromVault/);
  assert.doesNotMatch(vault, /evaluator.*payout|score.*amount|onlyOwner/si);
});

test("external UserEscrow has no mint-controller reference", async () => {
  const escrow = await source("contracts/v4/AgentPoolV41UserEscrow.sol");
  assert.match(escrow, /safeTransferFrom\(msg\.sender, address\(this\), budget\)/);
  assert.match(escrow, /keccak256\(abi\.encode\(recipients, amounts\)\)/);
  assert.doesNotMatch(escrow, /EmissionController|\.mint\(|onlyOwner/);
});

test("system versions are append-only and proven only by a system vault", async () => {
  const registry = await source("contracts/v4/AgentPoolV41ReleaseRegistry.sol");
  assert.match(registry, /controller\.isSystemVault\(msg\.sender\)/);
  assert.match(registry, /REGISTERED/);
  assert.match(registry, /PROVEN/);
  assert.match(registry, /CONTESTED/);
  assert.doesNotMatch(registry, /delete\s+modules|setOfficial|onlyOwner/);
});

test("v4.1 gateway keeps all four funding sources explicit", async () => {
  const [runtime, routes, mcp, chain] = await Promise.all([
    source("lib/v41.ts"),
    source("lib/v41-runtime.ts"),
    source("lib/mcp-public.ts"),
    source("lib/v41-chain.ts"),
  ]);
  assert.match(runtime, /CAPABILITY/);
  assert.match(runtime, /BASIC/);
  assert.match(runtime, /SYSTEM/);
  assert.match(runtime, /EXTERNAL/);
  assert.match(runtime, /CORE_EPOCH/);
  assert.match(runtime, /EVOLUTION_EPOCH/);
  assert.match(runtime, /USER_ESCROW/);
  assert.match(routes, /OFFCHAIN_RESERVED_V41_CHAIN_PENDING/);
  assert.match(routes, /v41BaseSepoliaDeployed:\s*true/);
  assert.match(routes, /gatewayOnchainWrites:\s*false/);
  assert.match(routes, /deploymentVerificationChecks:\s*34/);
  assert.match(routes, /postSmokeVerificationChecks:\s*40/);
  assert.match(chain, /deployments\/84532\.v41\.json/);
  assert.match(chain, /V41_DEPLOYMENT_BYTECODE_MISSING/);
  assert.match(chain, /epochRemainingApool/);
  assert.match(mcp, /agentpool_v41_opportunities/);
});

test("v4.1 public-chain preflight is read-only and fail-closed", async () => {
  const [preflight, packageJson] = await Promise.all([
    source("scripts/preflight-v41-base-sepolia.mjs"),
    source("package.json"),
  ]);
  assert.match(preflight, /writesPerformed:\s*false/);
  assert.match(preflight, /V41_CATALOG_SIGNERS must be unique/);
  assert.match(preflight, /V41_GENESIS_TIMESTAMP must be within/);
  assert.match(preflight, /V41_PARTIAL_DEPLOYMENT_REQUIRES_REVIEW/);
  assert.match(preflight, /V41_DEPLOYER_BALANCE_TOO_LOW/);
  assert.doesNotMatch(
    preflight,
    /createWalletClient|sendTransaction|writeContract|deployContract/,
  );
  assert.match(packageJson, /contracts:preflight:v4\.1/);
});

test("v4.1 bootstrap keeps fresh testnet keys local and funds only Base Sepolia", async () => {
  const [setup, funding, packageJson, gitignore] = await Promise.all([
    source("scripts/setup-v41-base-sepolia-wallets.mjs"),
    source("scripts/fund-v41-base-sepolia-deployer.mjs"),
    source("package.json"),
    source(".gitignore"),
  ]);
  assert.match(setup, /\.env\.v41\.local already exists/);
  assert.match(setup, /generatePrivateKey/);
  assert.match(setup, /catalogQuorum:\s*3/);
  assert.match(setup, /privateMaterial:\s*"\.env\.v41\.local"/);
  assert.doesNotMatch(setup, /privateKey:\s*deployerPrivateKey/);
  assert.match(funding, /SOURCE_WALLET_MUST_BE_DISPOSABLE_BASE_SEPOLIA/);
  assert.match(funding, /TARGET_WALLET_MUST_BE_DISPOSABLE_BASE_SEPOLIA/);
  assert.match(funding, /getChainId\(\)\) !== 84532/);
  assert.match(funding, /V41_DEPLOYER_MUST_BE_FRESH/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.ok(scripts["testnet:wallets:v4.1"]);
  assert.match(
    scripts["contracts:deploy:v4.1"],
    /\.env\.local.*\.env\.v41\.local/,
  );
  assert.match(gitignore, /\.env\*/);
});

test("v4.1 public smoke requires catalog quorum and proves exact settlement", async () => {
  const [smoke, packageJson] = await Promise.all([
    source("scripts/smoke-v41-base-sepolia.mjs"),
    source("package.json"),
  ]);
  assert.match(smoke, /V41_SMOKE_REQUIRES_DISPOSABLE_PROFILE/);
  assert.match(smoke, /V41_SMOKE_CATALOG_KEY_MISMATCH/);
  assert.match(smoke, /account\.signTypedData/);
  assert.match(smoke, /catalog\.slice\(0, manifest\.catalogQuorum\)/);
  assert.match(smoke, /supplyEqualsCommittedSmokePayout/);
  assert.match(smoke, /duplicateSettlementRejected/);
  assert.match(smoke, /artifactRecorded/);
  assert.ok(JSON.parse(packageJson).scripts["testnet:smoke:v4.1"]);
});

test("v4.1 receipt bridge never advances indexed state without exact chain evidence", async () => {
  const [
    bridge,
    award,
    confirm,
    accept,
    deliver,
    settle,
    runtime,
    schema,
    mcpBridge,
    sdk,
    packageJson,
  ] =
    await Promise.all([
      source("lib/v41-chain-bridge.ts"),
      source("app/api/v4.1/opportunities/[id]/award/route.ts"),
      source("app/api/v4.1/chain/confirm/route.ts"),
      source("app/api/v4.1/assignments/[id]/accept/route.ts"),
      source("app/api/v4.1/assignments/[id]/deliver/route.ts"),
      source("app/api/v4.1/assignments/[id]/settle/route.ts"),
      source("lib/v41-runtime.ts"),
      source("db/runtime.ts"),
      source("mcp/agentpool-local.mjs"),
      source("sdk/index.ts"),
      source("package.json"),
    ]);
  assert.match(bridge, /getTransactionReceipt/);
  assert.match(bridge, /getTransaction\(/);
  assert.match(bridge, /decodeFunctionData/);
  assert.match(bridge, /decodeEventLog/);
  assert.match(bridge, /INVALID_V41_ACTION_CALLER/);
  assert.match(bridge, /INVALID_V41_SETTLEMENT_TERMS/);
  assert.match(award, /verifyV41Award/);
  assert.match(award, /V41_ASSIGNMENT_OPENED/);
  assert.match(confirm, /verifyV41EpochAction/);
  assert.match(confirm, /INSERT OR IGNORE INTO protocol_events/);
  assert.doesNotMatch(accept, /SET state = 'ACCEPTED'/);
  assert.match(accept, /buildV41AcceptTransaction/);
  assert.doesNotMatch(deliver, /SET state = 'DELIVERED'/);
  assert.match(deliver, /buildV41DeliverTransaction/);
  assert.match(settle, /validateV41SettlementTerms/);
  assert.match(runtime, /gatewayWriteStatus:\s*"RECEIPT_BRIDGE_READY"/);
  assert.match(runtime, /serverCustodiesKeys:\s*false/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS v41_chain_assignments/);
  assert.match(schema, /open_tx_hash TEXT NOT NULL UNIQUE/);
  assert.match(mcpBridge, /agentpool_v41_accept_assignment/);
  assert.match(mcpBridge, /agentpool_v41_deliver_assignment/);
  assert.match(mcpBridge, /agentpool_v41_settle_assignment/);
  assert.match(mcpBridge, /executeV41PreparedAction/);
  assert.match(sdk, /registerV41Award/);
  assert.match(sdk, /settleV41Assignment/);
  assert.match(sdk, /confirmV41ChainAction/);
  assert.ok(JSON.parse(packageJson).scripts["testnet:bridge:verify:v4.1"]);
});

test("v4.1 external pilot gives a zero-context agent a sealed-bid to settlement path", async () => {
  const [
    pilot,
    operator,
    award,
    assignments,
    payouts,
    mcp,
    runtime,
    packageJson,
  ] = await Promise.all([
    source("protocol/v41-external-pilot.json"),
    source("scripts/open-v41-external-pilot.mjs"),
    source("app/api/v4.1/opportunities/[id]/award/route.ts"),
    source("app/api/v4.1/assignments/route.ts"),
    source("app/api/v4.1/jobs/[id]/payouts/route.ts"),
    source("mcp/agentpool-local.mjs"),
    source("lib/v41-runtime.ts"),
    source("package.json"),
  ]);
  assert.match(pilot, /canonical-mcp-fixture/);
  assert.match(operator, /V41_PILOT_REQUIRES_DISPOSABLE_PROFILE/);
  assert.match(operator, /catalog\.slice\(0, manifest\.catalogQuorum\)/);
  assert.match(operator, /waitForTransactionReceipt/);
  assert.match(operator, /settlementTerms/);
  assert.doesNotMatch(operator, /chainId:\s*8453\b|baseMainnet|mainnet\s*:/);
  assert.match(award, /validateV41AwardSettlementCommitment/);
  assert.doesNotMatch(award, /AUTH_V41_AWARD_PARTICIPANT/);
  assert.match(assignments, /LOWER\(a\.worker_address\) = LOWER\(\?\)/);
  assert.match(assignments, /settlementTerms/);
  assert.match(payouts, /settlementTerms/);
  assert.match(mcp, /agentpool_v41_commit_bid/);
  assert.match(mcp, /agentpool_v41_reveal_bid/);
  assert.match(mcp, /agentpool_v41_assignments/);
  assert.match(mcp, /agentpool_v41_complete_pilot/);
  assert.match(mcp, /V41_PILOT_RESULT_MISMATCH/);
  assert.match(runtime, /v41-external-pilot\.json/);
  assert.ok(JSON.parse(packageJson).scripts["testnet:pilot:open:v4.1"]);
});
