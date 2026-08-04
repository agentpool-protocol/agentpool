import fs from "node:fs";
import path from "node:path";
import {
  loadRunnerReports,
  validateTwoRunnerCampaign,
} from "./lib/v44-two-runner-evidence.mjs";

const root = process.cwd();
const directory = path.join(root, "outputs", "v44-two-runner");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "mainnet-v44-deployment-stages.json")),
);
const campaign = validateTwoRunnerCampaign(
  loadRunnerReports(directory),
  policy,
);
const outputPath = path.join(root, "outputs", "v44-two-runner-campaign.json");
fs.writeFileSync(outputPath, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...campaign, outputPath }, null, 2));
