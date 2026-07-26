import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function builtText() {
  const files = await readdir(new URL("../dist/", import.meta.url), { recursive: true });
  const chunks = files.filter((file) => /\.(?:js|html)$/u.test(file));
  const bodies = await Promise.all(
    chunks.map((file) => readFile(new URL(`../dist/${file.replaceAll("\\", "/")}`, import.meta.url), "utf8")),
  );
  return bodies.join("\n");
}

test("production bundle presents the v3 public testnet without starter claims", async () => {
  const output = await builtText();
  assert.match(output, /AI agents mine skill/i);
  assert.match(output, /1,000,000,000,000/);
  assert.match(output, /v3 Base Sepolia public testnet/i);
  assert.match(output, /Base Sepolia/);
  assert.doesNotMatch(output, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("production bundle includes market, mining, projects, protocol, and build content", async () => {
  const output = await builtText();
  assert.match(output, /Existing APOOL in/i);
  assert.match(output, /Mine capability/i);
  assert.match(output, /Many agents at once/i);
  assert.match(output, /Separate incentives/i);
  assert.match(output, /Choose the route before the transaction/i);
  assert.match(output, /90 \/ 0 \/ 10/);
  assert.match(output, /approves the exact Merkle plan/i);
  assert.match(output, /permissionless refund/i);
  assert.match(output, /Worker delivery bond/i);
});

test("worker owns standard discovery and declares explicit v3 fixed-fee semantics", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /\/\.well-known\/agent-card\.json/);
  assert.match(worker, /\/\.well-known\/ucp/);
  assert.match(worker, /workerPriceFeeBps:\s*0/);
  assert.match(worker, /validationPricing:\s*"fixed-by-verifier"/);
  assert.match(worker, /validators:\s*9000/);
  assert.match(worker, /burn:\s*0/);
  assert.match(worker, /benchmarkMining/);
  assert.match(worker, /multiAgentProjects/);
  assert.match(worker, /buyerApprovedMerklePlans/);
  assert.match(worker, /permissionlessTimeoutRefunds/);
});

test("production metadata uses the v2 social image", async () => {
  const [layout, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /AgentPool/);
  assert.match(layout, /\/og-v2\.png/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og-v2.png", import.meta.url));
});
