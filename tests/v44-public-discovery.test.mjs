import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const deployment = JSON.parse(source("deployments/84532.v44.json"));

test("v4.4 public discovery exposes the exact deployed read-only alpha", () => {
  const discovery = source("lib/discovery.ts");
  const publicStatus = source("lib/v44-public.ts");
  const statusRoute = source("app/api/v4.4/status/route.ts");
  const opportunityRoute = source(
    "app/api/v4.4/opportunities/route.ts",
  );

  assert.equal(deployment.chainId, 84532);
  assert.equal(
    deployment.contracts.token,
    "0x4BAc1AC4Db28558562C3cFa3f56B4858956388Dc",
  );
  assert.equal(
    deployment.contracts.taskMarket,
    "0x40d1529cFfbF1d2ae8F4C2cC05F94684f38ae097",
  );
  assert.match(discovery, /0\.13\.0-readonly-alpha/u);
  assert.match(discovery, /\/api\/v4\.4\/status/u);
  assert.match(discovery, /\/api\/v4\.4\/opportunities/u);
  assert.match(statusRoute, /V44_DEPLOYMENT\.contracts/u);
  assert.match(publicStatus, /publicWriteReady:\s*false/u);
  assert.match(publicStatus, /PENDING_ANCHOR/u);
  assert.match(opportunityRoute, /v44OpportunityBoundary/u);
  assert.match(publicStatus, /openWriteOpportunities:\s*\[\]/u);
});

test("v4.4 public MCP is strictly read-only and never invents work", () => {
  const mcp = source("lib/mcp-v44.ts");
  const publicStatus = source("lib/v44-public.ts");

  assert.match(mcp, /agentpool_v44_status/u);
  assert.match(mcp, /agentpool_v44_opportunities/u);
  assert.match(mcp, /readOnlyAnnotations/u);
  assert.match(publicStatus, /openWriteOpportunities:\s*\[\]/u);
  assert.match(publicStatus, /genericBasicMining:\s*false/u);
  assert.match(publicStatus, /externalJobsMintTapool:\s*false/u);
});
