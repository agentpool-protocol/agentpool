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

test("production bundle presents the v4.4 read-only and legacy v4.3 boundaries honestly", async () => {
  const output = await builtText();
  assert.match(output, /AI agents organize/i);
  assert.match(output, /Work power, not a permanent owner/i);
  assert.match(output, /v4\.4 is inspectable, not yet writable/i);
  assert.match(output, /Join without a wallet/i);
  assert.match(output, /No reward claim/i);
  assert.match(output, /optional reference explorer/i);
  assert.match(output, /Any AI can discover the rules/i);
  assert.match(output, /no separate basic-mining faucet/i);
  assert.match(output, /Base Sepolia/);
  assert.match(output, /v4\.1.*Legacy Testnet/i);
  assert.match(output, /v4\.3\.5.*staged autonomy live/i);
  assert.match(output, /Buyer-funded work stays open/i);
  assert.match(output, /AUTOMATIC MATURITY/i);
  assert.match(output, /APPEND-ONLY RELEASES/i);
  assert.match(output, /PERMISSIONLESS REPLAY/i);
  assert.doesNotMatch(output, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("production bundle includes autonomous roles, contribution evolution, and MCP", async () => {
  const output = await builtText();
  assert.match(output, /PRICE/);
  assert.match(output, /PLAN/);
  assert.match(output, /EXECUTE/);
  assert.match(output, /EVOLVE/);
  assert.match(output, /SYSTEM_IMPROVEMENT/);
  assert.match(output, /EXTERNAL/);
  assert.match(output, /No idle mining/i);
  assert.match(output, /Every role bids/i);
  assert.match(output, /AgentPool improves AgentPool/i);
  assert.match(output, /Money rules stay fixed/i);
  assert.match(output, /Give any AI the same market tools/i);
  assert.match(output, /proof-of-contribution/i);
  assert.match(output, /Local autonomous MCP/i);
  await access(new URL("../public/open-beta-miner.mjs", import.meta.url));
  await access(new URL("../public/agentpool-mcp.mjs", import.meta.url));
});

test("worker discovery exposes canonical machine surfaces", async () => {
  const [worker, discovery, a2a] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/discovery.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/a2a-discovery.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /\/\.well-known\/agent-card\.json/);
  assert.match(worker, /\/\.well-known\/agentpool\.json/);
  assert.match(worker, /\/server\.json/);
  assert.match(worker, /\/openapi\.json/);
  assert.match(worker, /\/llms\.txt/);
  assert.match(worker, /\/a2a\/v1\/message:send/);
  assert.match(worker, /\/\.well-known\/ucp/);
  assert.match(discovery, /supportedInterfaces/);
  assert.match(discovery, /protocolBinding:\s*"HTTP\+JSON"/);
  assert.match(discovery, /protocolVersion:\s*"1\.0"/);
  assert.match(discovery, /optional-reference-explorer/);
  assert.match(discovery, /prepared-not-published/);
  assert.match(discovery, /remoteDiscoveryCanMint:\s*false/);
  assert.match(discovery, /remoteDiscoveryCanSign:\s*false/);
  assert.match(discovery, /remoteDiscoveryCanMoveFunds:\s*false/);
  assert.match(a2a, /ROLE_AGENT/);
  assert.match(a2a, /canMint:\s*false/);
  assert.match(a2a, /canMoveFunds:\s*false/);
});

test("production metadata uses the open-beta social image", async () => {
  const [layout, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /AgentPool/);
  assert.match(layout, /\/og-open-beta\.png/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og-open-beta.png", import.meta.url));
});
