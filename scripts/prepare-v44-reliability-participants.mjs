import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  readJson,
  requireAddress,
  requireEnv,
  requireThresholdAuthorityConfig,
} from "./lib/v44-mainnet.mjs";
import { resolveV44TestnetCampaignFiles } from "./lib/v44-chain-profile.mjs";
import {
  inspectReliabilityParticipants,
  reliabilityParticipantTemplate,
} from "./lib/v44-reliability-participants.mjs";

function argument(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export function participantExpectations(deployment) {
  return {
    campaignId: deployment.campaignId,
    sourceCommit: deployment.sourceCommit,
    thresholdAuthorityOwners: deployment.thresholdAuthorityOwners,
    thresholdAuthorityThreshold: deployment.thresholdAuthorityThreshold,
    validators: deployment.bootstrap.validators.map((entry) => ({
      address: entry.address,
      groupId: entry.group,
    })),
  };
}

export function participantExpectationsFromEnvironment(env = process.env) {
  const thresholdAuthority = requireThresholdAuthorityConfig(env);
  return {
    campaignId: requireEnv("V44_TESTNET_CAMPAIGN_ID", env),
    sourceCommit: requireEnv("V44_SOURCE_COMMIT", env).toLowerCase(),
    thresholdAuthorityOwners: thresholdAuthority.owners,
    thresholdAuthorityThreshold: thresholdAuthority.threshold,
    validators: [1, 2, 3].map((index) => ({
      address: requireAddress(`V44_VALIDATOR_${index}`, env),
      groupId: requireEnv(`V44_VALIDATOR_${index}_GROUP_ID`, env).toLowerCase(),
    })),
  };
}

export function prepareReliabilityParticipants({
  deploymentPath = null,
  expected = null,
  inputPath = null,
  outputPath,
  force = false,
}) {
  const deployment = deploymentPath ? readJson(deploymentPath) : null;
  const resolvedExpected =
    expected ?? (deployment ? participantExpectations(deployment) : null);
  if (!resolvedExpected) {
    throw new Error("V44_PARTICIPANT_EXPECTATIONS_MISSING");
  }
  if (inputPath) {
    const manifest = readJson(inputPath);
    return {
      action: "validate",
      campaignId: resolvedExpected.campaignId,
      sourceCommit: resolvedExpected.sourceCommit,
      inputPath,
      ...inspectReliabilityParticipants(manifest, resolvedExpected),
    };
  }
  if (fs.existsSync(outputPath) && !force) {
    throw new Error(`V44_PARTICIPANT_TEMPLATE_EXISTS:${outputPath}`);
  }
  const template = reliabilityParticipantTemplate(resolvedExpected);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return {
    action: "template",
    ready: false,
    campaignId: resolvedExpected.campaignId,
    sourceCommit: resolvedExpected.sourceCommit,
    outputPath,
    privateKeysIncluded: false,
    nextAction:
      "Independent participants fill public addresses, Ed25519 public keys, domains, RPC origins, and corroboration hashes, then set status to READY_FOR_REVIEW.",
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const files = resolveV44TestnetCampaignFiles(process.env);
  const expected = fs.existsSync(files.deploymentPath)
    ? participantExpectations(readJson(files.deploymentPath))
    : participantExpectationsFromEnvironment(process.env);
  const inputValue = argument("--input");
  const inputPath = inputValue ? path.resolve(inputValue) : null;
  const outputValue = argument("--output");
  const outputPath = path.resolve(
    outputValue ??
      path.join(
        ROOT,
        "outputs",
        `v44-reliability-participants.${files.campaignId}.local.json`,
      ),
  );
  const result = prepareReliabilityParticipants({
    expected,
    inputPath,
    outputPath,
    force: process.argv.includes("--force"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  if (inputPath && !result.ready) process.exitCode = 1;
}
