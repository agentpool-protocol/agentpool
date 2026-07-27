import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file) => fs.readFileSync(file, "utf8");
const kernel = read("contracts/v42/AgentPoolV42ImprovementKernel.sol");
const token = read("contracts/v42/AgentPoolV42Token.sol");
const userEscrow = read("contracts/v42/AgentPoolV42UserEscrow.sol");
const verifier = read("contracts/v42/AgentPoolV42HashImprovementVerifier.sol");
const mcp = read("mcp/agentpool-v42.mjs");
const manifest = JSON.parse(read("protocol/agentpool-v42.json"));

test("v4.2 has no generic basic-mining emission lane", () => {
  assert.doesNotMatch(kernel, /\bBASIC\b|basic mining|basicMining|MiningLane/i);
  assert.deepEqual(manifest.economy.emissionSources, [
    "PROVEN_AGENTPOOL_IMPROVEMENT",
  ]);
  assert.ok(
    manifest.economy.removedEmissionSources.includes("BASIC_MINING"),
  );
});

test("v4.2 token begins empty and only its immutable improvement path mints", () => {
  assert.match(token, /Zero-premint test token/);
  assert.match(token, /msg\.sender != improvementKernel/);
  assert.match(token, /totalSupply\(\) \+ amount > MAX_SUPPLY/);
  assert.doesNotMatch(kernel, /\bowner\b|onlyOwner|delegatecall|upgradeTo/i);
  assert.match(kernel, /token\.mint/);
});

test("AI votes cannot replace objective issue and canary proof", () => {
  assert.match(kernel, /verifyIssue/);
  assert.match(kernel, /scoreCandidate/);
  assert.match(kernel, /objectiveScoreBps < PASS_SCORE_BPS/);
  assert.match(kernel, /revealed % 2 == 0/);
  assert.match(verifier, /reproducer/);
  assert.doesNotMatch(
    kernel,
    /function\s+revealEvaluation[\s\S]{0,500}(recipient|payout)/,
  );
});

test("invalid work is unpaid and slashes are reused before new emission", () => {
  assert.match(
    kernel,
    /reproductions\[index\]\.revealed\s*&&\s*reproductions\[index\]\.passed/,
  );
  assert.match(kernel, /uint256 public slashPool/);
  assert.match(kernel, /uint256 newlyMinted = total - reused/);
  assert.match(kernel, /_consume\(issue, newlyMinted\)/);
});

test("external jobs can only move existing tAPOOL", () => {
  assert.match(userEscrow, /never mints new tAPOOL/);
  assert.doesNotMatch(userEscrow, /\.mint\(|ImprovementKernel|Emission/);
  assert.equal(manifest.economy.externalJobsMint, false);
});

test("v4.2 discovery and wallet bridge do not require a website", () => {
  assert.equal(manifest.websiteRequired, false);
  assert.equal(manifest.machineInterfaces.localMcp.transport, "stdio");
  assert.match(mcp, /BASE SEPOLIA TEST WALLET ONLY/);
  assert.match(mcp, /privateKeyExposed: false/);
  assert.match(mcp, /V42_DEPLOYMENT_PENDING/);
  assert.match(mcp, /agentpool_v42_open_issue/);
  assert.match(mcp, /agentpool_v42_submit_candidate/);
  assert.match(mcp, /agentpool_v42_resolve_external_job/);
});
