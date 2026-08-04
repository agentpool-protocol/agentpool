import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("canonical discovery separates the replaceable explorer from protocol authority", async () => {
  const source = await readFile(new URL("lib/discovery.ts", root), "utf8");
  assert.match(source, /role:\s*"optional-reference-explorer"/);
  assert.match(source, /authoritative:\s*false/);
  assert.match(source, /replaceable:\s*true/);
  assert.match(source, /releases:\s*\[/);
  assert.match(source, /release:\s*"v4\.4"/);
  assert.match(source, /release:\s*"v4\.3\.5"/);
  assert.match(source, /baseSepoliaDeployment:\s*v43\.network\.deployment/);
  assert.match(source, /remoteDiscoveryCanMint:\s*false/);
  assert.match(source, /remoteDiscoveryCanSign:\s*false/);
  assert.match(source, /remoteDiscoveryCanMoveFunds:\s*false/);
  assert.match(source, /Verify release hashes, chain IDs, contract addresses/);
  assert.match(source, /live-base-sepolia-legacy/);
  assert.match(source, /Remote discovery is read-only/);
  assert.match(source, /LEGACY_TEST_ECONOMY/);
  assert.match(source, /\/api\/mcp\/v4\.4/);
  assert.match(source, /\/api\/mcp\/v4\.3-legacy/);
  assert.match(source, /\/api\/v4\.3\/gas\/grants/);
  assert.match(source, /device-wallet-signed GAS_REQUEST/);
  assert.match(source, /mainnetAssetsAccepted:\s*false/);
  assert.match(source, /v43Coordination/);
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
  assert.match(source, /\/\.well-known\/agentpool\.json/);
  assert.match(source, /\/api\/v4\.1\/artifacts/);
  assert.match(source, /\/api\/v4\.3\/status/);
  assert.doesNotMatch(source, /privateKey|seed phrase|mint\(|transfer\(|EpochVault/);
});

test("remote MCP includes canonical discovery without write authority", async () => {
  const source = await readFile(new URL("lib/mcp-public.ts", root), "utf8");
  assert.match(source, /agentpool_discovery_manifest/);
  assert.match(source, /\/\.well-known\/agentpool\.json/);
  assert.match(source, /agentpool_v43_status/);
  assert.match(source, /cannot mint, sign, or move funds/i);
  assert.match(source, /readOnlyHint:\s*true/);
});
