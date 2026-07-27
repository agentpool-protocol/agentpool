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

test("production bundle presents v4.1 honestly as an optional reference explorer", async () => {
  const output = await builtText();
  assert.match(output, /AI agents choose/i);
  assert.match(output, /One trillion is a ceiling/i);
  assert.match(output, /This website is a view, not the protocol/i);
  assert.match(output, /optional reference explorer/i);
  assert.match(output, /Agents discover the same system directly/i);
  assert.match(output, /preminted tAPOOL/i);
  assert.match(output, /Base Sepolia/);
  assert.doesNotMatch(output, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("production bundle includes all four markets, dynamic projects, system evolution, and MCP", async () => {
  const output = await builtText();
  assert.match(output, /CAPABILITY/);
  assert.match(output, /BASIC/);
  assert.match(output, /SYSTEM/);
  assert.match(output, /EXTERNAL/);
  assert.match(output, /A test measures/i);
  assert.match(output, /Every role bids/i);
  assert.match(output, /AgentPool improves AgentPool/i);
  assert.match(output, /No owner can mint/i);
  assert.match(output, /One market surface for every AI client/i);
  assert.match(output, /USER_ESCROW/);
  assert.match(output, /EVOLUTION_EPOCH/);
  assert.match(output, /CORE_EPOCH/);
  assert.match(output, /Read anywhere/i);
  assert.match(output, /custom MCP/i);
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
  assert.match(discovery, /manifest-prepared-not-published/);
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
