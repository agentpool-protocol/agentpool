import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = fs.readFileSync(
  path.join(
    root,
    "contracts",
    "v43",
    "AgentPoolV439CandidateRewardPool.sol",
  ),
  "utf8",
);

test("v4.3.9 incubation rewards cannot become mainnet authority", () => {
  assert.match(contract, /block\.chainid != TESTNET_CHAIN_ID/);
  assert.match(contract, /TESTNET_CHAIN_ID = 84_532/);
  assert.match(contract, /CREATES_WORK_POWER = false/);
  assert.match(contract, /CAN_RECOMMEND_RELEASE = false/);
  assert.match(contract, /CAN_MINT = false/);
  assert.doesNotMatch(
    contract,
    /\bowner\b|delegatecall|function\s+mint|setSource|recordOutcome/,
  );
});

test("v4.3.9 quotes are fixed before each role executes", () => {
  assert.match(contract, /function submitCandidateBid\(/);
  assert.match(contract, /planCommitment/);
  assert.match(contract, /function commitValidation\(/);
  assert.match(contract, /validatorQuoteTotal/);
  assert.match(contract, /function revealValidation\(/);
  assert.match(contract, /validationCommitment\(/);
});

test("v4.3.9 rehearsal proves dynamic multi-role payment and replay protection", () => {
  const rehearsal = fs.readFileSync(
    path.join(root, "scripts", "rehearse-v439-candidate-reward.mjs"),
    "utf8",
  );
  for (const requirement of [
    "one AI receives the sum of reporter, implementer, and validator quotes",
    "only proven role quotes leave the finite pool",
    "unused issue budget is released",
    "settlement cannot pay the same roles twice",
    "expired work releases every reserved token",
    "a validator cannot reveal a different score",
    "a rejected candidate pays neither reporter nor implementer",
    "valid negative validation work still receives its quoted fee",
    "a rejected artifact never becomes proven",
  ]) {
    assert.match(rehearsal, new RegExp(requirement));
  }
});

test("v4.3.9 deployment is Base Sepolia-only and preflight checks both gas payers", () => {
  const deploy = fs.readFileSync(
    path.join(root, "scripts", "deploy-v439-candidate-reward.mjs"),
    "utf8",
  );
  const preflight = fs.readFileSync(
    path.join(root, "scripts", "preflight-v439-candidate-reward.mjs"),
    "utf8",
  );
  assert.match(deploy, /baseSepolia/);
  assert.match(deploy, /V439_CHAIN_MISMATCH/);
  assert.match(deploy, /V439_PARTIAL_IDENTITY_MISMATCH/);
  assert.match(deploy, /V439_DEPLOYER_PRIVATE_KEY/);
  assert.match(deploy, /V439_FUNDER_PRIVATE_KEY/);
  assert.doesNotMatch(deploy, /baseMainnet|mainnet/);
  assert.match(preflight, /minimumDeployBalance/);
  assert.match(preflight, /minimumFunderBalance/);
  assert.match(preflight, /funderBalance >= minimumFunderBalance/);
});
