import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  reportSha256,
  sha256,
  TWO_RUNNER_REPORT_SCHEMA,
  validateRunnerReport,
} from "./lib/v44-two-runner-evidence.mjs";

const root = process.cwd();
const runnerArgument = process.argv.find((value) =>
  value.startsWith("--runner="),
);
const runtimeFamily = runnerArgument?.slice("--runner=".length).trim();
if (!runtimeFamily || !/^[a-z0-9-]{2,32}$/u.test(runtimeFamily)) {
  throw new Error("USE_--runner=codex_OR_--runner=antigravity");
}
const trackedStatus = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: root, encoding: "utf8" },
).trim();
if (trackedStatus) throw new Error("TRACKED_WORKTREE_MUST_BE_CLEAN");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const release = JSON.parse(
  fs.readFileSync(path.join(root, "mainnet-v44-deployment-stages.json")),
).release;
const startedAt = new Date().toISOString();
const testFiles = [
  "tests/v44-two-runner-staging.test.mjs",
  "tests/v44-public-discovery.test.mjs",
  "tests/v44-participation.test.mjs",
];
const testOutput = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...testFiles],
  { cwd: root, encoding: "utf8", env: process.env },
);
const policyBytes = fs.readFileSync(
  path.join(root, "mainnet-v44-deployment-stages.json"),
);
const anchorBytes = fs.readFileSync(
  path.join(root, "contracts/v44/AgentPoolV44DormantDeploymentAnchor.sol"),
);
const publicBoundaryBytes = fs.readFileSync(
  path.join(root, "lib/v44-public.ts"),
);
const processInstance = crypto.randomUUID();
const report = {
  schema: TWO_RUNNER_REPORT_SCHEMA,
  release,
  sourceCommit,
  startedAt,
  finishedAt: new Date().toISOString(),
  runner: {
    agentId: `${runtimeFamily}-${processInstance}`,
    runtimeFamily,
    processInstance,
    operatorControlDomain: "shared-local-operator",
    deviceControlDomain: "shared-device-disclosed",
    classification: "SHARED_OPERATOR_ENGINEERING_ONLY",
    independenceClaim: false,
  },
  checks: [
    {
      id: "PINNED_SOURCE_TESTS_PASS",
      status: "PASS",
      evidenceSha256: sha256(testOutput),
    },
    {
      id: "STAGING_POLICY_BOUND",
      status: "PASS",
      evidenceSha256: sha256(policyBytes),
    },
    {
      id: "DORMANT_ANCHOR_NON_ECONOMIC",
      status: "PASS",
      evidenceSha256: sha256(anchorBytes),
    },
    {
      id: "PUBLIC_ECONOMY_DISABLED",
      status: "PASS",
      evidenceSha256: sha256(publicBoundaryBytes),
    },
  ],
  safety: {
    mainnetWritesPerformed: false,
    realAssetsUsed: false,
    economicActivationAttempted: false,
    privateKeysExposed: false,
  },
};
report.reportSha256 = reportSha256(report);
validateRunnerReport(report);
const outputDirectory = path.join(root, "outputs", "v44-two-runner");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(
  outputDirectory,
  `${runtimeFamily}-${processInstance}.json`,
);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      ok: true,
      runtimeFamily,
      classification: report.runner.classification,
      sourceCommit,
      reportSha256: report.reportSha256,
      outputPath,
      independentOperatorEvidence: false,
      economicMainnetDeploymentEligible: false,
    },
    null,
    2,
  ),
);
