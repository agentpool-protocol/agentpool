import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/v44-mainnet.mjs";
import {
  buildReliabilityReport,
  RELIABILITY_SCHEMA,
} from "./lib/v44-testnet-reliability.mjs";
import { resolveV44TestnetCampaignFiles } from "./lib/v44-chain-profile.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function optionalPath(cliName, envName, fallback) {
  const value = argument(cliName) ?? process.env[envName]?.trim() ?? fallback;
  return value ? path.resolve(value) : null;
}

const campaignFiles = resolveV44TestnetCampaignFiles(process.env);

export async function generatePublicTestnetReliability({
  policyPath = optionalPath(
    "--policy",
    "V44_TESTNET_RELIABILITY_POLICY",
    path.join(ROOT, "mainnet-v44-testnet-reliability-policy.json"),
  ),
  deploymentPath = optionalPath(
    "--deployment",
    "V44_TESTNET_DEPLOYMENT_MANIFEST",
    campaignFiles.deploymentPath,
  ),
  observationsPath = path.resolve(
    argument("--observations") ??
      process.env.V44_TESTNET_OBSERVATIONS_FILE?.trim() ??
      process.env.V44_TESTNET_OBSERVATIONS?.trim() ??
      campaignFiles.observationsPath,
  ),
  sourceEvidencePath = path.resolve(
    argument("--source-evidence") ??
      process.env.V44_TESTNET_CONTRACT_SOURCE_EVIDENCE?.trim() ??
      (campaignFiles.campaignId
        ? campaignFiles.sourceEvidencePath
        : process.env.V44_SOURCE_EVIDENCE_FILE?.trim() ??
          campaignFiles.sourceEvidencePath),
  ),
  rpcUrl =
    argument("--rpc-url") ??
    process.env.AGENTPOOL_V44_TESTNET_RPC_URL?.trim() ??
    process.env.AGENTPOOL_RPC_URL?.trim() ??
    process.env.BASE_SEPOLIA_RPC_URL?.trim() ??
    null,
  secondaryRpcUrl =
    argument("--secondary-rpc-url") ??
    process.env.AGENTPOOL_V44_TESTNET_RPC_URL_2?.trim() ??
    null,
  generatedAt,
} = {}) {
  return buildReliabilityReport({
    policyPath,
    deploymentPath,
    observationsPath,
    sourceEvidencePath,
    rpcUrl,
    secondaryRpcUrl,
    generatedAt,
    expectedCampaignId: campaignFiles.campaignId,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const outputPath = path.resolve(
    argument("--output") ??
      process.env.V44_TESTNET_RELIABILITY_OUTPUT?.trim() ??
      campaignFiles.reliabilityPath,
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
