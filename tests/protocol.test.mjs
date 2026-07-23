import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("fixed supply and allocation sum are encoded without an external mint", async () => {
  const token = await readFile(new URL("../contracts/AgentPoolToken.sol", import.meta.url), "utf8");
  assert.match(token, /MAX_SUPPLY = 1_000_000_000 ether/);
  assert.match(token, /MINING_ALLOCATION = 500_000_000 ether/);
  assert.match(token, /OPERATOR_ALLOCATION = 200_000_000 ether/);
  assert.match(token, /ECOSYSTEM_ALLOCATION = 150_000_000 ether/);
  assert.match(token, /LIQUIDITY_ALLOCATION = 100_000_000 ether/);
  assert.match(token, /SECURITY_ALLOCATION = 50_000_000 ether/);
  assert.doesNotMatch(token, /function\s+mint\s*\(/);
  assert.match(token, /assert\(totalSupply\(\) == MAX_SUPPLY\)/);
});

test("fee starts at zero and immutable maximum is 25 bps", async () => {
  const escrow = await readFile(new URL("../contracts/AgentPoolJobEscrow.sol", import.meta.url), "utf8");
  assert.match(escrow, /MAX_PROTOCOL_FEE_BPS = 25/);
  assert.match(escrow, /newFeeBps > MAX_PROTOCOL_FEE_BPS/);
  assert.match(escrow, /newFeeBps > 0 && costReportHash == bytes32\(0\)/);
  assert.doesNotMatch(escrow, /protocolFeeBps\s*=\s*[1-9]/);
});

test("mining schedule is exactly capped, 520 epochs, and non-increasing", async () => {
  const schedule = JSON.parse(await readFile(new URL("../mining-schedule.json", import.meta.url), "utf8"));
  assert.equal(schedule.epochs, 520);
  assert.equal(schedule.budgetsWei.length, 520);
  const values = schedule.budgetsWei.map(BigInt);
  assert.equal(values.reduce((sum, value) => sum + value, 0n), 500_000_000n * 10n ** 18n);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] <= values[index - 1]);
  }
});

test("mainnet deployment is blocked while independent gates are incomplete", async () => {
  const gates = JSON.parse(await readFile(new URL("../mainnet-gates.json", import.meta.url), "utf8"));
  assert.equal(gates.chainId, 8453);
  assert.ok(Object.values(gates.gates).every((gate) => gate.status === "blocked"));
  const deploy = await readFile(new URL("../scripts/deploy.mjs", import.meta.url), "utf8");
  assert.match(deploy, /MAINNET_BLOCKED/);
  assert.match(deploy, /MAINNET_AUDIT_REPORT_SHA256/);
  assert.match(deploy, /CHAINLINK_VRF_ADAPTER/);
});

test("all first-party Solidity contracts compile into nonempty bytecode", async () => {
  const files = (await readdir(new URL("../artifacts/", import.meta.url)))
    .filter((name) => name.startsWith("AgentPool") && name.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const artifact = JSON.parse(await readFile(new URL(`../artifacts/${file}`, import.meta.url), "utf8"));
    assert.ok(artifact.bytecode.startsWith("0x"));
    assert.ok(artifact.bytecode.length > 100);
  }
  await assert.doesNotReject(readFile(new URL("../contracts/AgentPoolWorkOracle.sol", import.meta.url)));
  assert.ok(root);
});
