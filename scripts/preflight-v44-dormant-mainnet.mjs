import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildDormantAnchorIntent } from "./lib/v44-dormant-anchor.mjs";

const root = process.cwd();
const trackedStatus = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: root, encoding: "utf8" },
).trim();
if (trackedStatus) throw new Error("TRACKED_WORKTREE_MUST_BE_CLEAN");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath));
const json = (relativePath) => JSON.parse(read(relativePath));
const campaignPath = path.join(root, "outputs", "v44-two-runner-campaign.json");
if (!fs.existsSync(campaignPath)) {
  throw new Error("TWO_RUNNER_CAMPAIGN_EVIDENCE_MISSING");
}
const intent = buildDormantAnchorIntent({
  campaign: JSON.parse(fs.readFileSync(campaignPath, "utf8")),
  policy: json("mainnet-v44-deployment-stages.json"),
  artifact: json("artifacts/AgentPoolV44DormantDeploymentAnchor.json"),
  gitTreeId: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  releaseConfigBytes: read("mainnet-v44-config.json"),
  stagingPolicyBytes: read("mainnet-v44-deployment-stages.json"),
});
const outputPath = path.join(root, "outputs", "v44-dormant-anchor-intent.json");
fs.writeFileSync(outputPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      ok: true,
      outputPath,
      ...intent,
      transactionSent: false,
      realAssetsUsed: false,
    },
    null,
    2,
  ),
);
