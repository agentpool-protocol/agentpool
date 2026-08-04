import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  reportSha256,
  TWO_RUNNER_REPORT_SCHEMA,
  validateRunnerReport,
  validateTwoRunnerCampaign,
} from "../scripts/lib/v44-two-runner-evidence.mjs";
import {
  buildDormantAnchorIntent,
} from "../scripts/lib/v44-dormant-anchor.mjs";

const root = process.cwd();
const source = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const policy = JSON.parse(source("mainnet-v44-deployment-stages.json"));

function report(runtimeFamily, processInstance, overrides = {}) {
  const value = {
    schema: TWO_RUNNER_REPORT_SCHEMA,
    release: policy.release,
    sourceCommit: "a".repeat(40),
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:01:00.000Z",
    runner: {
      agentId: `${runtimeFamily}-${processInstance}`,
      runtimeFamily,
      processInstance,
      operatorControlDomain: "shared-local-operator",
      deviceControlDomain: "shared-device-disclosed",
      classification: "SHARED_OPERATOR_ENGINEERING_ONLY",
      independenceClaim: false,
    },
    checks: ["SOURCE", "POLICY", "ANCHOR", "PUBLIC"].map((id, index) => ({
      id,
      status: "PASS",
      evidenceSha256: String(index + 1).padStart(64, "0"),
    })),
    safety: {
      mainnetWritesPerformed: false,
      realAssetsUsed: false,
      economicActivationAttempted: false,
      privateKeysExposed: false,
    },
    ...overrides,
  };
  value.reportSha256 = reportSha256(value);
  return value;
}

test("Codex and Antigravity on one computer count only as engineering evidence", () => {
  const campaign = validateTwoRunnerCampaign(
    [report("codex", "process-a"), report("antigravity", "process-b")],
    policy,
  );
  assert.equal(campaign.eligible, true);
  assert.equal(campaign.dormantAnchorDeploymentEligible, true);
  assert.equal(campaign.economicMainnetDeploymentEligible, false);
  assert.equal(campaign.countsTowardIndependentOperators, false);
  assert.equal(campaign.countsTowardIndependentCustody, false);
  assert.deepEqual(campaign.runtimeFamilies, ["antigravity", "codex"]);
});

test("one runtime cannot forge the two-runner threshold", () => {
  assert.throws(
    () =>
      validateTwoRunnerCampaign(
        [report("codex", "process-a"), report("codex", "process-b")],
        policy,
      ),
    /TWO_RUNNER_RUNTIME_FAMILIES_INSUFFICIENT/u,
  );
});

test("shared runners cannot claim independent control or economic activation", () => {
  const forged = report("antigravity", "process-b");
  forged.runner.independenceClaim = true;
  forged.reportSha256 = reportSha256(forged);
  assert.throws(
    () => validateRunnerReport(forged),
    /SHARED_RUNNER_CANNOT_CLAIM_INDEPENDENCE/u,
  );

  const unsafe = report("antigravity", "process-c");
  unsafe.safety.economicActivationAttempted = true;
  unsafe.reportSha256 = reportSha256(unsafe);
  assert.throws(
    () => validateRunnerReport(unsafe),
    /REPORT_SAFETY_economicActivationAttempted/u,
  );
});

test("dormant mainnet stage contains no economic or activation surface", () => {
  const stage = policy.stages.DORMANT_MAINNET;
  assert.deepEqual(stage.allowedContracts, [
    "AgentPoolV44DormantDeploymentAnchor",
  ]);
  assert.equal(stage.tokenDeploymentAllowed, false);
  assert.equal(stage.emissionAllowed, false);
  assert.equal(stage.rewardAllowed, false);
  assert.equal(stage.userDepositsAllowed, false);
  assert.equal(stage.taskSettlementAllowed, false);
  assert.equal(stage.activationTransactionExists, false);
  assert.equal(stage.requiresSeparateMatureDeployment, true);

  const contract = source(
    "contracts/v44/AgentPoolV44DormantDeploymentAnchor.sol",
  );
  const executableSource = contract.replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(
    executableSource,
    /\bowner\b|\badmin\b|mint\s*\(|transfer\s*\(|delegatecall|upgrade|activate\s*\(/iu,
  );
  assert.match(contract, /deploymentCommitment = keccak256/u);
  const artifact = JSON.parse(
    source("artifacts/AgentPoolV44DormantDeploymentAnchor.json"),
  );
  const functions = artifact.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => ({ name: entry.name, mutability: entry.stateMutability }));
  assert.ok(functions.length > 0);
  assert.ok(functions.every((entry) => entry.mutability === "view"));
  assert.deepEqual(
    functions.map((entry) => entry.name).sort(),
    [
      "DOMAIN",
      "deploymentCommitment",
      "engineeringEvidenceRoot",
      "releaseConfigHash",
      "sourceTreeHash",
      "stagingPolicyHash",
    ],
  );
});

test("dormant anchor intent accepts engineering evidence without enabling economics", () => {
  const campaign = validateTwoRunnerCampaign(
    [report("codex", "process-a"), report("antigravity", "process-b")],
    policy,
  );
  const intent = buildDormantAnchorIntent({
    campaign,
    policy,
    artifact: JSON.parse(
      source("artifacts/AgentPoolV44DormantDeploymentAnchor.json"),
    ),
    candidateSourceCommit: "a".repeat(40),
    gitTreeId: "b".repeat(40),
    releaseConfigBytes: Buffer.from(source("mainnet-v44-config.json")),
    stagingPolicyBytes: Buffer.from(
      source("mainnet-v44-deployment-stages.json"),
    ),
  });
  assert.equal(intent.targetChainId, 8453);
  assert.equal(intent.candidateSourceCommit, "a".repeat(40));
  assert.equal(intent.economicSystemDeployed, false);
  assert.equal(intent.tokenDeployed, false);
  assert.equal(intent.emissionEnabled, false);
  assert.equal(intent.rewardsEnabled, false);
  assert.equal(intent.userDepositsEnabled, false);
  assert.equal(intent.settlementEnabled, false);
  assert.equal(intent.laterActivationPossible, false);
  assert.equal(intent.requiresSeparateMatureDeployment, true);
  assert.equal(intent.constructorArgs.length, 4);
});

test("dormant anchor cannot relabel engineering evidence as another source", () => {
  const campaign = validateTwoRunnerCampaign(
    [report("codex", "process-a"), report("antigravity", "process-b")],
    policy,
  );
  assert.throws(
    () =>
      buildDormantAnchorIntent({
        campaign,
        policy,
        artifact: JSON.parse(
          source("artifacts/AgentPoolV44DormantDeploymentAnchor.json"),
        ),
        candidateSourceCommit: "c".repeat(40),
        gitTreeId: "b".repeat(40),
        releaseConfigBytes: Buffer.from("config"),
        stagingPolicyBytes: Buffer.from("policy"),
      }),
    /CAMPAIGN_SOURCE_COMMIT_MISMATCH/u,
  );
});
