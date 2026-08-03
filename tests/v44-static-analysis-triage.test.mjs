import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("v4.4 external escrow cannot pull from an arbitrary buyer", () => {
  const escrow = source(
    "contracts/v43/AgentPoolV43UserEscrowKernel.sol",
  );
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");

  assert.match(escrow, /if \(msg\.sender != market\) revert Unauthorized\(\)/);
  assert.match(escrow, /if \(market != address\(0\)\) revert AlreadyConfigured\(\)/);
  assert.match(escrow, /configurationAuthority = address\(0\)/);
  assert.match(
    escrow,
    /token\.safeTransferFrom\(buyer, address\(this\), amount\)/,
  );

  assert.match(
    market,
    /function createExternalJob\([\s\S]*?revert Unauthorized\(\)/,
  );
  assert.match(
    market,
    /function createExternalJobV2\([\s\S]*?userEscrow\.lock\(jobId, msg\.sender, budget\)/,
  );
});

test("v4.4 money-moving market entrypoints are reentrancy guarded", () => {
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");

  for (const entrypoint of [
    "createExternalJobV2",
    "createSystemJobV2",
    "acceptMilestone",
    "resolve",
    "refundExpired",
  ]) {
    assert.match(
      market,
      new RegExp(
        `function ${entrypoint}\\([\\s\\S]*?\\) external[^\\{]*nonReentrant`,
      ),
      `${entrypoint} must remain nonReentrant`,
    );
  }
});

test("v4.4 one-shot callback paths commit state before external calls", () => {
  const baseMarket = source("contracts/v43/AgentPoolV43TaskMarket.sol");
  const market = source("contracts/v43/AgentPoolV432TaskMarket.sol");

  const deliveryState = market.indexOf(
    "milestone.state = MilestoneState.DELIVERED;",
  );
  const openRound = market.indexOf("proofRegistryV2.openRoundWithPolicy(");
  assert.ok(deliveryState > 0);
  assert.ok(openRound > deliveryState);

  const attestedState = baseMarket.indexOf(
    "milestone.candidateAttested = true;",
  );
  const attestCall = baseMarket.indexOf("settlementRouter.attestCandidate(");
  assert.ok(attestedState > 0);
  assert.ok(attestCall > attestedState);

  const adoptionState = baseMarket.indexOf(
    "milestone.adoptionRecorded = true;",
  );
  const adoptionCall = baseMarket.indexOf(
    "settlementRouter.recordAdoption(",
  );
  assert.ok(adoptionState > 0);
  assert.ok(adoptionCall > adoptionState);
});

test("v4.4 static-analysis triage remains explicitly non-authoritative", () => {
  const triage = source("audits/V44_SLITHER_TRIAGE.md");
  const packet = source("audits/V44_GPT_REVIEW_PACKET.md");
  const collaborative = source(
    "audits/V44_GPT_COLLABORATIVE_REVIEW.md",
  );
  const checker = source("scripts/check-v44-slither.mjs");
  const workflow = source(".github/workflows/ci.yml");
  const baseline = JSON.parse(
    source("audits/v44-slither-baseline.json"),
  );

  assert.match(triage, /not an independent audit/i);
  assert.match(triage, /does not satisfy `mainnet-v44-gates\.json`/);
  assert.match(triage, /High:\s+2 reported, 0 confirmed/);
  assert.match(triage, /Medium:\s+28 reported, 0 confirmed/);
  assert.match(triage, /npm run security:slither:v4\.4/);
  assert.match(
    collaborative,
    /not an independent\s+security audit/i,
  );
  assert.match(
    collaborative,
    /validator non-participation.*NO_QUORUM/is,
  );
  assert.match(
    collaborative,
    /276 transactions, 33 checks, 24 bootstrap\s+objectives/,
  );

  assert.match(packet, /git rev-parse HEAD/);
  assert.match(packet, /sha256\(outputs\/v44-source-reproducibility\.json\)/);
  assert.match(packet, /release-gate decision for this exact commit/i);
  assert.match(packet, /BLOCK.*REVIEW_INCOMPLETE.*NO_CONFIRMED_BLOCKER/s);

  assert.equal(
    baseline.schema,
    "agentpool.security.slither-baseline/v1",
  );
  assert.equal(Object.keys(baseline.contracts).length, 15);
  assert.deepEqual(
    baseline.contracts.AgentPoolV44PolicyAnchor,
    {
      sourceName: "contracts/v44/AgentPoolV44PolicyAnchor.sol",
      detectors: {},
    },
  );
  assert.match(checker, /V44_SLITHER_BASELINE_CHANGED/);
  assert.match(checker, /detector\.impact !== "High"/);
  assert.match(checker, /detector\.impact !== "Medium"/);
  assert.match(workflow, /security-static:/);
  assert.match(workflow, /slither-analyzer==0\.11\.6/);
  assert.match(workflow, /solc-select install 0\.8\.36/);
  assert.match(workflow, /npm run security:slither:v4\.4/);
});
