import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  ROOT,
  currentGitCommit,
  readJson,
} from "./v44-mainnet.mjs";
import {
  autonomyPolicyIdentity,
  collectPolicyActivationPublicationSnapshot,
  collectLiveRpcEvidence,
  loadReliabilityPolicy,
  reconcilePolicyActivationPublicationSnapshots,
  validateAutonomyPolicy,
  validateObservations,
  validateTestnetDeployment,
  verifyHistoricalContractSourceEvidenceFile,
} from "./v44-testnet-reliability.mjs";
import {
  newExposureLedger,
  validateAutonomyEvidence,
} from "./v44-autonomy-safety.mjs";
import { resolveV44TestnetCampaignFiles } from "./v44-chain-profile.mjs";
import { verifyPublishedBootstrapSpecifications } from "./v44-bootstrap-specifications.mjs";

export const DEFAULT_V44_TESTNET_DEPLOYMENT_PATH = path.join(
  ROOT,
  "deployments",
  "84532.v44.json",
);
export const DEFAULT_V44_TESTNET_OBSERVATIONS_PATH = path.join(
  ROOT,
  "outputs",
  "v44-public-testnet-observations.json",
);
export const DEFAULT_V44_SOURCE_EVIDENCE_PATH = path.join(
  ROOT,
  "deployments",
  "84532.v44.source-reproducibility.json",
);

export function argument(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const value = argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

export function requiredArgument(name, argv = process.argv.slice(2)) {
  const value = argument(name, argv);
  if (!value) throw new Error(`V44_TESTNET_ARGUMENT_MISSING:${name}`);
  return value;
}

export function resolveLedgerPaths(env = process.env) {
  const campaignFiles = resolveV44TestnetCampaignFiles(env);
  return {
    deploymentPath: path.resolve(
      env.V44_TESTNET_DEPLOYMENT_MANIFEST ??
        campaignFiles.deploymentPath,
    ),
    observationsPath: path.resolve(
      env.V44_TESTNET_OBSERVATIONS_FILE ??
        env.V44_TESTNET_OBSERVATIONS ??
        campaignFiles.observationsPath,
    ),
    sourceEvidencePath: path.resolve(
      env.V44_TESTNET_CONTRACT_SOURCE_EVIDENCE ??
        env.V44_TESTNET_SOURCE_EVIDENCE_FILE ??
        (campaignFiles.campaignId
          ? campaignFiles.sourceEvidencePath
          : env.V44_SOURCE_EVIDENCE_FILE ??
            campaignFiles.sourceEvidencePath),
    ),
    bootstrapSpecificationsPath:
      env.V44_TESTNET_BOOTSTRAP_SPECIFICATIONS ??
      campaignFiles.bootstrapSpecificationsPath,
    campaignId: campaignFiles.campaignId,
  };
}

export function loadLedgerContext(env = process.env) {
  const paths = resolveLedgerPaths(env);
  for (const [label, filePath] of Object.entries(paths).filter(
    ([key, value]) =>
      key !== "campaignId" &&
      key !== "observationsPath" &&
      Boolean(value),
  )) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`V44_TESTNET_FILE_MISSING:${label}:${filePath}`);
    }
  }
  const policyEvidence = loadReliabilityPolicy();
  const rawDeployment = readJson(paths.deploymentPath);
  if (
    paths.campaignId &&
    rawDeployment.campaignId !== paths.campaignId
  ) {
    throw new Error("V44_TESTNET_CAMPAIGN_MANIFEST_MISMATCH");
  }
  const sourceEvidence = verifyHistoricalContractSourceEvidenceFile(
    paths.sourceEvidencePath,
    rawDeployment,
  ).evidence;
  const deployment = validateTestnetDeployment(
    rawDeployment,
    sourceEvidence,
  );
  if (paths.campaignId) {
    verifyPublishedBootstrapSpecifications({
      filePath: paths.bootstrapSpecificationsPath,
      deployment,
      sourceEvidence,
    });
  }
  return {
    ...paths,
    policyEvidence,
    sourceEvidence,
    deployment,
    evidencePipelineCommit: currentGitCommit().toLowerCase(),
  };
}

export function newObservationLedger({
  deployment,
  policyEvidence,
  evidencePipelineCommit,
  startedAt,
  endedAt,
}) {
  const policyIdentity = autonomyPolicyIdentity(
    policyEvidence.policy.autonomyV2,
    evidencePipelineCommit,
  );
  return {
    schema: "agentpool.testnet.v44.observations/v1",
    observedChainId: 84532,
    release: deployment.release,
    contractSourceCommit: deployment.sourceCommit,
    evidencePipelineCommit,
    deploymentManifestSha256: deployment.manifestSha256,
    policySha256: policyEvidence.policySha256,
    signerSetHash: policyIdentity.signerSetHash,
    policyActivatedAt: policyIdentity.activatedAt,
    policyActivatedBlock: policyIdentity.activatedBlock,
    policyActivationSequence: policyIdentity.activationSequence,
    policyActivationAnchorHash: policyIdentity.activationAnchorHash,
    startedAt,
    endedAt,
    observations: [],
    incidents: [],
    attestations: [],
    maturityReadinessEvidence: null,
    autonomyEvidence: {
      schema: "agentpool.v44.autonomy-evidence/v1",
      exposureLedger: newExposureLedger(),
      admissionBundles: [],
      settlementBundles: [],
      governanceEventIds: [],
      governanceEventProviders: [],
      checkpoints: [],
      checkpointPolicy: {
        authorizedPublicKeys: [],
        threshold: 2,
      },
      anchorStatus: "PENDING_ANCHOR",
    },
  };
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporaryPath, filePath);
}

export async function appendTestnetObservation({
  category,
  txHash,
  recordedBy = "permissionless",
  rpcUrl,
  allowExisting = false,
  context = loadLedgerContext(),
  client = null,
  collectEvidence = collectLiveRpcEvidence,
  validate = validateLedger,
} = {}) {
  const normalizedTxHash = txHash?.toLowerCase();
  const rule = context.policyEvidence.policy.categories[category];
  if (!rule) throw new Error(`V44_TESTNET_CATEGORY_UNKNOWN:${category}`);
  if (!/^0x[0-9a-f]{64}$/u.test(normalizedTxHash ?? "")) {
    throw new Error("V44_TESTNET_TX_HASH_INVALID");
  }
  if (!rpcUrl) throw new Error("V44_TESTNET_RPC_URL_REQUIRED");

  const existing = fs.existsSync(context.observationsPath)
    ? readJson(context.observationsPath)
    : null;
  if (existing) {
    validate(existing, {
      policy: context.policyEvidence.policy,
      policySha256: context.policyEvidence.policySha256,
      deployment: context.deployment,
      evidencePipelineCommit: context.evidencePipelineCommit,
    });
  }
  if (
    existing?.observations.some(
      (entry) => entry.txHash.toLowerCase() === normalizedTxHash,
    )
  ) {
    if (!allowExisting) {
      throw new Error("V44_TESTNET_OBSERVATION_TX_REUSED");
    }
    return {
      alreadyRecorded: true,
      category,
      txHash: normalizedTxHash,
      observationCount: existing.observations.length,
      observationsPath: context.observationsPath,
    };
  }

  const activeClient =
    client ??
    createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
    });
  if ((await activeClient.getChainId()) !== 84532) {
    throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
  }
  const receipt = await activeClient.getTransactionReceipt({
    hash: normalizedTxHash,
  });
  const block = await activeClient.getBlock({ blockNumber: receipt.blockNumber });
  const blockTime = new Date(Number(block.timestamp) * 1_000);
  const next = existing
    ? structuredClone(existing)
    : newObservationLedger({
        deployment: context.deployment,
        policyEvidence: context.policyEvidence,
        evidencePipelineCommit: context.evidencePipelineCommit,
        startedAt: new Date(blockTime.getTime() - 1).toISOString(),
        endedAt: blockTime.toISOString(),
      });
  next.observations.push({
    category,
    txHash: normalizedTxHash,
    contractKey: rule.contractKey,
    expectedStatus: rule.transactionStatus,
    blockNumber: Number(receipt.blockNumber),
    recordedBy,
  });
  const observedAt = blockTime.toISOString();
  if (Date.parse(observedAt) < Date.parse(next.startedAt)) {
    next.startedAt = new Date(blockTime.getTime() - 1).toISOString();
  }
  if (Date.parse(observedAt) > Date.parse(next.endedAt)) {
    next.endedAt = observedAt;
  }
  next.attestations = [];
  validate(next, {
    policy: context.policyEvidence.policy,
    policySha256: context.policyEvidence.policySha256,
    deployment: context.deployment,
    evidencePipelineCommit: context.evidencePipelineCommit,
  });
  await collectEvidence({
    rpcUrl,
    deployment: context.deployment,
    observations: next,
    policy: context.policyEvidence.policy,
  });
  writeJsonAtomic(context.observationsPath, next);
  return {
    alreadyRecorded: false,
    category,
    txHash: normalizedTxHash,
    blockNumber: Number(receipt.blockNumber),
    observationCount: next.observations.length,
    attestationsReset: true,
    observationsPath: context.observationsPath,
  };
}

export async function assertTestnetReliabilityAdmissionReady({
  primaryRpcUrl,
  secondaryRpcUrl,
  context = loadLedgerContext(),
} = {}) {
  if (!primaryRpcUrl || !secondaryRpcUrl) {
    throw new Error("V44_BOOTSTRAP_ADMISSION_TWO_RPCS_REQUIRED");
  }
  if (!fs.existsSync(context.observationsPath)) {
    throw new Error("V44_BOOTSTRAP_ADMISSION_OBSERVATIONS_MISSING");
  }
  const observations = readJson(context.observationsPath);
  const trustedAutonomyPolicy = context.policyEvidence.policy.autonomyV2 ?? {};
  const resolvedAutonomyPolicy = {
    ...trustedAutonomyPolicy,
    policyActivation:
      observations.policyActivation ?? trustedAutonomyPolicy.policyActivation,
  };
  validateAutonomyPolicy(resolvedAutonomyPolicy);
  for (const [label, value] of [
    ["OBSERVERS", resolvedAutonomyPolicy.observerIndependencePolicy],
    ["PROVIDERS", resolvedAutonomyPolicy.governanceEventProviderPolicy],
    ["ACTIVATION", resolvedAutonomyPolicy.policyActivation],
    ["CONTROL_DOMAINS", resolvedAutonomyPolicy.controlDomainPolicy],
    ["CHECKPOINTS", resolvedAutonomyPolicy.checkpointPolicy],
    ["MATURITY", resolvedAutonomyPolicy.maturityAuthorizationPolicy],
  ]) {
    if (value?.configurationStatus !== "ACTIVE") {
      throw new Error(`V44_BOOTSTRAP_ADMISSION_${label}_NOT_ACTIVE`);
    }
  }
  const providerPolicy = resolvedAutonomyPolicy.governanceEventProviderPolicy;
  const operatorFor = (rpcUrl) => {
    const origin = new URL(rpcUrl).origin;
    const provider = providerPolicy.providers.find((candidate) =>
      candidate.allowedOrigins.includes(origin),
    );
    if (!provider) {
      throw new Error("V44_BOOTSTRAP_ADMISSION_RPC_OPERATOR_NOT_PINNED");
    }
    return provider.operatorId;
  };
  const primaryOperatorId = operatorFor(primaryRpcUrl);
  const secondaryOperatorId = operatorFor(secondaryRpcUrl);
  if (primaryOperatorId === secondaryOperatorId) {
    throw new Error("V44_BOOTSTRAP_ADMISSION_RPC_OPERATORS_NOT_INDEPENDENT");
  }
  const activationSnapshots = await Promise.all([
    collectPolicyActivationPublicationSnapshot({
      rpcUrl: primaryRpcUrl,
      deployment: context.deployment,
      activation: resolvedAutonomyPolicy.policyActivation,
      providerOperatorId: primaryOperatorId,
    }),
    collectPolicyActivationPublicationSnapshot({
      rpcUrl: secondaryRpcUrl,
      deployment: context.deployment,
      activation: resolvedAutonomyPolicy.policyActivation,
      providerOperatorId: secondaryOperatorId,
    }),
  ]);
  const trustedActivationPublications =
    reconcilePolicyActivationPublicationSnapshots({
      providers: activationSnapshots,
      providerOperatorPolicy: providerPolicy,
    }).publications;
  const resolvedPolicy = {
    ...context.policyEvidence.policy,
    autonomyV2: resolvedAutonomyPolicy,
  };
  validateObservations(observations, {
    policy: resolvedPolicy,
    policySha256: context.policyEvidence.policySha256,
    deployment: context.deployment,
    evidencePipelineCommit: context.evidencePipelineCommit,
    trustedActivationPublications,
  });
  return {
    ready: true,
    primaryOperatorId,
    secondaryOperatorId,
    observationCount: observations.observations.length,
    activationSequence:
      resolvedAutonomyPolicy.policyActivation.activationSequence,
  };
}

export function validateLedger(
  ledger,
  { policy, policySha256, deployment, evidencePipelineCommit },
) {
  validateObservations(ledger, {
    policy,
    policySha256,
    deployment,
    evidencePipelineCommit,
  });
  if (ledger.autonomyEvidence) {
    validateAutonomyEvidence(ledger.autonomyEvidence);
  }
  return ledger;
}
