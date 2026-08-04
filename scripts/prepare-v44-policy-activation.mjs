import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256 } from "viem";
import { baseSepolia } from "viem/chains";
import {
  ROOT,
  artifact,
  assertTrackedTreeClean,
  currentGitCommit,
  loadAndValidateConfig,
  readJson,
} from "./lib/v44-mainnet.mjs";
import { loadLedgerContext, writeJsonAtomic } from "./lib/v44-observation-ledger.mjs";
import {
  participantExpectations,
} from "./prepare-v44-reliability-participants.mjs";
import { validateReliabilityParticipants } from "./lib/v44-reliability-participants.mjs";
import { buildPolicyActivationPackage } from "./lib/v44-policy-activation-workflow.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export async function preparePolicyActivation({
  context = loadLedgerContext(),
  participantsPath,
  rpcUrl,
  outputPath,
  deadlineSeconds = 86_400,
  client = null,
}) {
  if (!participantsPath || !fs.existsSync(participantsPath)) {
    throw new Error("V44_POLICY_ACTIVATION_PARTICIPANTS_MISSING");
  }
  if (!rpcUrl) throw new Error("V44_POLICY_ACTIVATION_RPC_MISSING");
  assertTrackedTreeClean();
  if (
    !Number.isSafeInteger(deadlineSeconds) ||
    deadlineSeconds < 600 ||
    deadlineSeconds > 604_800
  ) {
    throw new Error("V44_POLICY_ACTIVATION_DEADLINE_INVALID");
  }
  const participants = readJson(participantsPath);
  const participantEvidence = validateReliabilityParticipants(
    participants,
    participantExpectations(context.deployment),
  );
  const providerOrigins = participants.governanceRpcProviders.flatMap(
    (provider) => provider.allowedOrigins,
  );
  if (!providerOrigins.includes(new URL(rpcUrl).origin)) {
    throw new Error("V44_POLICY_ACTIVATION_RPC_NOT_PINNED");
  }
  const activeClient =
    client ??
    createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
    });
  if ((await activeClient.getChainId()) !== 84532) {
    throw new Error("V44_POLICY_ACTIVATION_CHAIN_MISMATCH");
  }
  const [authorityCode, operationNonce, finalizedBlock] = await Promise.all([
    activeClient.getBytecode({
      address: context.deployment.contracts.thresholdAuthority,
    }),
    activeClient.readContract({
      address: context.deployment.contracts.thresholdAuthority,
      abi: artifact("AgentPoolV44ThresholdAuthority").abi,
      functionName: "nonce",
    }),
    activeClient.getBlock({ blockTag: "finalized" }),
  ]);
  if (
    !authorityCode ||
    keccak256(authorityCode).toLowerCase() !==
      context.deployment.deployedCodeHashes.thresholdAuthority.toLowerCase()
  ) {
    throw new Error("V44_POLICY_ACTIVATION_AUTHORITY_CODE_MISMATCH");
  }
  const nowSeconds = Number(finalizedBlock.timestamp);
  const { config } = loadAndValidateConfig();
  const activationPackage = buildPolicyActivationPackage({
    baseAutonomyPolicy: context.policyEvidence.policy.autonomyV2,
    participants,
    participantManifestSha256: participantEvidence.manifestSha256,
    deployment: context.deployment,
    config,
    evidencePipelineCommit: currentGitCommit().toLowerCase(),
    operationNonce,
    deadline: nowSeconds + deadlineSeconds,
    nowSeconds,
  });
  writeJsonAtomic(outputPath, activationPackage);
  return {
    ok: true,
    campaignId: context.deployment.campaignId,
    sourceCommit: context.deployment.sourceCommit,
    evidencePipelineCommit: activationPackage.evidencePipelineCommit,
    participantManifestSha256: participantEvidence.manifestSha256,
    packageSha256: activationPackage.packageSha256,
    requestSha256: activationPackage.request.requestSha256,
    operationDigest: activationPackage.request.operationDigest,
    deadline: activationPackage.request.deadline,
    outputPath,
    signaturesRequired: context.deployment.thresholdAuthorityThreshold,
    privateKeysIncluded: false,
    chainWritePerformed: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const context = loadLedgerContext();
  const participantsValue =
    argument("participants") ??
    process.env.V44_RELIABILITY_PARTICIPANTS_FILE;
  if (!participantsValue) {
    throw new Error("V44_POLICY_ACTIVATION_PARTICIPANTS_MISSING");
  }
  const participantsPath = path.resolve(participantsValue);
  const outputPath = path.resolve(
    argument("output") ??
      path.join(
        ROOT,
        "outputs",
        `v44-policy-activation-package.${context.deployment.campaignId}.local.json`,
      ),
  );
  const result = await preparePolicyActivation({
    context,
    participantsPath,
    rpcUrl:
      process.env.AGENTPOOL_V44_TESTNET_RPC_URL ??
      process.env.V44_TESTNET_RPC_URL,
    outputPath,
    deadlineSeconds: Number(argument("deadline-seconds") ?? 86_400),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
