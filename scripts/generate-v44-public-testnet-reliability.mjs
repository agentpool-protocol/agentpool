import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/v44-mainnet.mjs";
import {
  buildReliabilityReport,
  RELIABILITY_SCHEMA,
} from "./lib/v44-testnet-reliability.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function optionalPath(cliName, envName, fallback) {
  const value = argument(cliName) ?? process.env[envName]?.trim() ?? fallback;
  return value ? path.resolve(value) : null;
}

export async function generatePublicTestnetReliability({
  policyPath = optionalPath(
    "--policy",
    "V44_TESTNET_RELIABILITY_POLICY",
    path.join(ROOT, "mainnet-v44-testnet-reliability-policy.json"),
  ),
  deploymentPath = optionalPath(
    "--deployment",
    "V44_TESTNET_DEPLOYMENT_MANIFEST",
    path.join(ROOT, "deployments", "84532.v44.json"),
  ),
  observationsPath = optionalPath(
    "--observations",
    "V44_TESTNET_OBSERVATIONS",
    path.join(ROOT, "outputs", "v44-public-testnet-observations.json"),
  ),
  sourceEvidencePath = optionalPath(
    "--source-evidence",
    "V44_SOURCE_EVIDENCE_FILE",
    path.join(ROOT, "outputs", "v44-source-reproducibility.json"),
  ),
  rpcUrl =
    argument("--rpc-url") ??
    process.env.AGENTPOOL_V44_TESTNET_RPC_URL?.trim() ??
    process.env.AGENTPOOL_RPC_URL?.trim() ??
    process.env.BASE_SEPOLIA_RPC_URL?.trim() ??
    null,
  generatedAt,
} = {}) {
  return buildReliabilityReport({
    policyPath,
    deploymentPath,
    observationsPath,
    sourceEvidencePath,
    rpcUrl,
    generatedAt,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const outputPath = path.resolve(
    argument("--output") ??
      path.join(ROOT, "outputs", "v44-public-testnet-reliability.json"),
  );
  const report = await generatePublicTestnetReliability();
  if (report.schema !== RELIABILITY_SCHEMA) {
    throw new Error("V44_TESTNET_RELIABILITY_REPORT_SCHEMA_INVALID");
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      eligible: report.eligible,
      decision: report.decision,
      blockers: report.blockers,
      outputPath,
    }, null, 2)}\n`,
  );
  if (process.argv.includes("--require-eligible") && !report.eligible) {
    process.exitCode = 1;
  }
}
