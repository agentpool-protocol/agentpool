import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadRunnerReports,
  selectRunnerReportsForSource,
  validateTwoRunnerCampaign,
} from "./lib/v44-two-runner-evidence.mjs";

const root = process.cwd();
const directory = path.join(root, "outputs", "v44-two-runner");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "mainnet-v44-deployment-stages.json")),
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const allReports = loadRunnerReports(directory);
const selectedReports = selectRunnerReportsForSource(
  allReports,
  sourceCommit,
  policy.release,
);
const campaign = validateTwoRunnerCampaign(
  selectedReports,
  policy,
);
const outputPath = path.join(root, "outputs", "v44-two-runner-campaign.json");
fs.writeFileSync(outputPath, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      ...campaign,
      outputPath,
      selectedReportCount: selectedReports.length,
      ignoredStaleReportCount: allReports.length - selectedReports.length,
    },
    null,
    2,
  ),
);
