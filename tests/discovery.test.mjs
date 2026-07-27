import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("canonical discovery separates the replaceable explorer from protocol authority", async () => {
  const source = await readFile(new URL("lib/discovery.ts", root), "utf8");
  assert.match(source, /role:\s*"optional-reference-explorer"/);
  assert.match(source, /authoritative:\s*false/);
  assert.match(source, /replaceable:\s*true/);
  assert.match(source, /money:\s*"Base chain events and immutable settlement contracts"/);
  assert.match(source, /remoteDiscoveryCanMint:\s*false/);
  assert.match(source, /remoteDiscoveryCanSign:\s*false/);
  assert.match(source, /remoteDiscoveryCanMoveFunds:\s*false/);
  assert.match(source, /Re-fetch the canonical HTTPS manifest before acting/);
  assert.match(source, /public-alpha-live-base-sepolia/);
  assert.match(source, /gatewayOnchainWrites:\s*false/);
  assert.match(source, /deployments\/84532\.v41\.json/);
});

test("A2A card and server manifest follow current discovery shapes", async () => {
  const source = await readFile(new URL("lib/discovery.ts", root), "utf8");
  const cardSource = source.slice(
    source.indexOf("export function buildA2AAgentCard"),
    source.indexOf("export function buildMcpServerManifest"),
  );
  assert.match(source, /supportedInterfaces/);
  assert.match(source, /protocolBinding:\s*"HTTP\+JSON"/);
  assert.match(source, /protocolVersion:\s*"1\.0"/);
  assert.doesNotMatch(cardSource, /\n\s+url:\s*origin,\s*\n/);
  assert.match(
    source,
    /https:\/\/static\.modelcontextprotocol\.io\/schemas\/2025-12-11\/server\.schema\.json/,
  );
  assert.match(source, /type:\s*"streamable-http"/);
  assert.match(source, /publicationStatus:\s*"prepared-not-published"/);
});

test("A2A discovery agent is read-only and cannot become an emission path", async () => {
  const source = await readFile(new URL("lib/a2a-discovery.ts", root), "utf8");
  assert.match(source, /canMint:\s*false/);
  assert.match(source, /canSign:\s*false/);
  assert.match(source, /canMoveFunds:\s*false/);
  assert.match(source, /\/api\/v4\.1\/opportunities/);
  assert.match(source, /\/api\/v4\.1\/artifacts/);
  assert.match(source, /\/api\/v4\.1\/status/);
  assert.doesNotMatch(source, /privateKey|seed phrase|mint\(|transfer\(|EpochVault/);
});

test("remote MCP includes canonical discovery without write authority", async () => {
  const source = await readFile(new URL("lib/mcp-public.ts", root), "utf8");
  assert.match(source, /agentpool_discovery_manifest/);
  assert.match(source, /\/api\/v4\.1\/discovery/);
  assert.match(source, /cannot mint, sign, or move funds/i);
  assert.match(source, /readOnlyHint:\s*true/);
});
