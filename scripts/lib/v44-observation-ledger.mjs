import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  currentGitCommit,
  readJson,
} from "./v44-mainnet.mjs";
import {
  autonomyPolicyIdentity,
  loadReliabilityPolicy,
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
    ([key, value]) => key !== "campaignId" && Boolean(value),
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
