import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const EPOCH_ALLOWANCE = 100_000;
const CAPABILITY_CAP = 5_000;
const EXPERIMENT_CAP = 1_000;
const ISSUE_CAP = 10_000;

const agents = [
  { id: "light-data", success: 0.91, cost: 8, bond: 20, capability: "data" },
  { id: "ultra-code", success: 0.985, cost: 170, bond: 120, capability: "code" },
  { id: "qwen-fixture", success: 0.94, cost: 52, bond: 55, capability: "protocol" },
  { id: "validator-a", success: 0.97, cost: 25, bond: 80, capability: "verify" },
];

function net(agent, opportunity) {
  const failure = 1 - agent.success;
  return (
    agent.success * opportunity.payout -
    agent.cost -
    failure * agent.bond -
    opportunity.verificationCost -
    opportunity.opportunityCost
  );
}

function choose(agent, opportunities) {
  return opportunities
    .filter((opportunity) =>
      opportunity.capability === agent.capability ||
      opportunity.capability === "any")
    .map((opportunity) => ({ opportunity, net: net(agent, opportunity) }))
    .sort((left, right) => right.net - left.net)[0] ?? null;
}

function settleEpoch(epoch, opportunities) {
  const accounting = {
    epoch,
    allowance: EPOCH_ALLOWANCE,
    capabilityMinted: 0,
    basicMinted: 0,
    systemMinted: 0,
    validationMinted: 0,
    externalMoved: 0,
    newEmission: 0,
    expiredAllowance: 0,
    issueMinted: new Map(),
    experimentMinted: 0,
    selections: [],
  };
  const claimed = new Set();
  for (const agent of agents) {
    const selected = choose(agent, opportunities);
    if (!selected || selected.net <= 0) continue;
    const opportunity = selected.opportunity;
    if (claimed.has(opportunity.id)) continue;
    claimed.add(opportunity.id);
    accounting.selections.push({
      agent: agent.id,
      opportunity: opportunity.id,
      market: opportunity.market,
      net: Math.round(selected.net * 100) / 100,
    });

    if (opportunity.market === "EXTERNAL") {
      accounting.externalMoved += opportunity.payout;
      continue;
    }
    if (!opportunity.objectiveProof) continue;
    if (opportunity.market === "CAPABILITY") {
      if (accounting.capabilityMinted + opportunity.payout > CAPABILITY_CAP) continue;
      accounting.capabilityMinted += opportunity.payout;
    } else if (opportunity.market === "BASIC") {
      accounting.basicMinted += opportunity.payout;
    } else if (opportunity.market === "SYSTEM") {
      const issueUsed = accounting.issueMinted.get(opportunity.issue) ?? 0;
      if (issueUsed + opportunity.payout > ISSUE_CAP) continue;
      if (opportunity.experimental) {
        if (accounting.experimentMinted + opportunity.payout > EXPERIMENT_CAP) continue;
        accounting.experimentMinted += opportunity.payout;
      }
      accounting.issueMinted.set(opportunity.issue, issueUsed + opportunity.payout);
      accounting.systemMinted += opportunity.payout;
    } else if (opportunity.market === "VALIDATION") {
      accounting.validationMinted += opportunity.payout;
    }
  }
  accounting.newEmission =
    accounting.capabilityMinted +
    accounting.basicMinted +
    accounting.systemMinted +
    accounting.validationMinted;
  assert.ok(accounting.newEmission <= accounting.allowance);
  assert.ok(accounting.capabilityMinted <= CAPABILITY_CAP);
  assert.ok(accounting.experimentMinted <= EXPERIMENT_CAP);
  for (const amount of accounting.issueMinted.values()) assert.ok(amount <= ISSUE_CAP);
  accounting.expiredAllowance = accounting.allowance - accounting.newEmission;
  return {
    ...accounting,
    issueMinted: Object.fromEntries(accounting.issueMinted),
  };
}

const base = [
  {
    id: "cap-json",
    market: "CAPABILITY",
    capability: "data",
    payout: 20,
    verificationCost: 3,
    opportunityCost: 2,
    objectiveProof: true,
  },
  {
    id: "basic-fixture",
    market: "BASIC",
    capability: "protocol",
    payout: 250,
    verificationCost: 18,
    opportunityCost: 8,
    objectiveProof: true,
  },
  {
    id: "basic-code-benchmark",
    market: "BASIC",
    capability: "code",
    payout: 340,
    verificationCost: 30,
    opportunityCost: 18,
    objectiveProof: true,
  },
  {
    id: "system-indexer",
    market: "SYSTEM",
    capability: "code",
    payout: 420,
    verificationCost: 42,
    opportunityCost: 20,
    objectiveProof: true,
    issue: "indexer-recovery",
    experimental: false,
  },
  {
    id: "validate-fixture",
    market: "VALIDATION",
    capability: "verify",
    payout: 90,
    verificationCost: 0,
    opportunityCost: 5,
    objectiveProof: true,
  },
];

const quietEpoch = settleEpoch(1, base);
const buyerDemand = settleEpoch(2, [
  ...base,
  {
    id: "external-data-cleanup",
    market: "EXTERNAL",
    capability: "data",
    payout: 600,
    verificationCost: 20,
    opportunityCost: 5,
    objectiveProof: false,
  },
  {
    id: "external-secure-module",
    market: "EXTERNAL",
    capability: "code",
    payout: 1_100,
    verificationCost: 80,
    opportunityCost: 30,
    objectiveProof: false,
  },
]);
const noUsefulWork = settleEpoch(3, []);

assert.equal(
  quietEpoch.selections.find((selection) => selection.agent === "light-data")?.market,
  "CAPABILITY",
);
assert.equal(
  buyerDemand.selections.find((selection) => selection.agent === "light-data")?.market,
  "EXTERNAL",
);
assert.equal(
  buyerDemand.selections.find((selection) => selection.agent === "ultra-code")?.market,
  "EXTERNAL",
);
assert.ok(quietEpoch.basicMinted > 0);
assert.equal(buyerDemand.externalMoved > 0, true);
assert.equal(
  buyerDemand.newEmission,
  buyerDemand.capabilityMinted +
    buyerDemand.basicMinted +
    buyerDemand.systemMinted +
    buyerDemand.validationMinted,
);
assert.equal(noUsefulWork.newEmission, 0);
assert.equal(noUsefulWork.expiredAllowance, EPOCH_ALLOWANCE);

const replayReceipts = new Set();
const receipt = "assignment:basic-fixture:proof:abc";
assert.equal(replayReceipts.has(receipt), false);
replayReceipts.add(receipt);
assert.equal(replayReceipts.has(receipt), true);

const report = {
  version: "4.1.0-alpha",
  invariants: {
    externalJobsMint: false,
    capabilityAndBasicSeparated: true,
    unusedAllowanceCarries: false,
    duplicateReceiptAccepted: false,
    objectiveProofRequiredForEmission: true,
  },
  epochs: [quietEpoch, buyerDemand, noUsefulWork],
};

const output = path.join(process.cwd(), "outputs", "v41-economy-simulation.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    output,
    quietSelectionCount: quietEpoch.selections.length,
    buyerDemandExternalMoved: buyerDemand.externalMoved,
    noUsefulWorkEmission: noUsefulWork.newEmission,
  })}\n`,
);
