import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("v4.4 participation is zero-wallet, read-only, and reward honest", () => {
  const kit = source("lib/v44-participation.ts");
  const route = source("app/api/v4.4/participate/route.ts");
  const page = source("app/participate/page.tsx");
  const prompt = source("public/agentpool-v44-participant-prompt.txt");
  const antigravityPrompt = source(
    "public/agentpool-v44-antigravity-two-runner-prompt.txt",
  );

  assert.match(kit, /mode:\s*"PUBLIC_READ_ONLY_ALPHA"/u);
  assert.match(kit, /walletRequired:\s*false/u);
  assert.match(kit, /gasRequired:\s*false/u);
  assert.match(kit, /rewardTapool:\s*"0"/u);
  assert.match(kit, /rewardPromise:\s*false/u);
  assert.match(route, /v44ParticipationKit/u);
  assert.match(page, /Join without a wallet/u);
  assert.match(page, /No reward claim/u);
  assert.match(prompt, /Do not create a wallet/u);
  assert.match(prompt, /Do not claim independent control/u);
  assert.match(kit, /antigravityTwoRunnerPrompt/u);
  assert.match(antigravityPrompt, /SHARED_OPERATOR_ENGINEERING_ONLY/u);
  assert.match(antigravityPrompt, /Do not start a background daemon/u);
  assert.match(antigravityPrompt, /Do not use a wallet/u);
});

test("all public discovery surfaces expose the same participation boundary", () => {
  const discovery = source("lib/discovery.ts");
  const mcp = source("lib/mcp-public.ts");
  const server = JSON.parse(source("server.json"));

  assert.match(discovery, /\/api\/v4\.4\/participate/u);
  assert.match(discovery, /\/agentpool-v44-participant-prompt\.txt/u);
  assert.match(mcp, /agentpool_v44_participation_kit/u);
  assert.equal(
    server.name,
    "io.github.agentpool-protocol/agentpool",
  );
  assert.deepEqual(server.remotes, [
    {
      type: "streamable-http",
      url: "https://agentpool-protocol.asfu.chatgpt.site/api/mcp/v4.4",
    },
  ]);
});

test("outreach copy cannot advertise current earnings or fake independence", () => {
  const outreach = source("docs/OUTREACH_V44.md");
  const participation = source("docs/PARTICIPATE_V44.md");
  const observationTemplate = source(
    ".github/ISSUE_TEMPLATE/v44-readonly-observation.yml",
  );

  assert.match(outreach, /Current reward: 0 tAPOOL/u);
  assert.match(outreach, /Do not use `earn now`/u);
  assert.match(outreach, /Official MCP Registry/u);
  assert.match(participation, /reward of `0 tAPOOL`/u);
  assert.match(
    participation,
    /not\s+guaranteed retroactive payment/u,
  );
  assert.match(observationTemplate, /no promised current or retroactive reward/u);
  assert.match(observationTemplate, /Control-domain relationship/u);
});
