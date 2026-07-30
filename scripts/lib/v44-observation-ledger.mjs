import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  readJson,
} from "./v44-mainnet.mjs";
import {
  loadReliabilityPolicy,
  validateObservations,
  validateTestnetDeployment,
} from "./v44-testnet-reliability.mjs";
import {
  newExposureLedger,
  validateAutonomyEvidence,
} from "./v44-autonomy-safety.mjs";

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
  "outputs",
  "v44-source-reproducibility.json",
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
  return {
    deploymentPath: path.resolve(
      env.V44_TESTNET_DEPLOYMENT_MANIFEST ??
        DEFAULT_V44_TESTNET_DEPLOYMENT_PATH,
    ),
    observationsPath: path.resolve(
      env.V44_TESTNET_OBSERVATIONS_FILE ??
        DEFAULT_V44_TESTNET_OBSERVATIONS_PATH,
    ),
    sourceEvidencePath: path.resolve(
      env.V44_SOURCE_EVIDENCE_FILE ??
        DEFAULT_V44_SOURCE_EVIDENCE_PATH,
    ),
  };
}

export function loadLedgerContext(env = process.env) {
  const paths = resolveLedgerPaths(env);
  for (const [label, filePath] of Object.entries(paths)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`V44_TESTNET_FILE_MISSING:${label}:${filePath}`);
    }
  }
  const policyEvidence = loadReliabilityPolicy();
  const sourceEvidence = readJson(paths.sourceEvidencePath);
  const deployment = validateTestnetDeployment(
    readJson(paths.deploymentPath),
    sourceEvidence,
  );
  return {
    ...paths,
    policyEvidence,
    sourceEvidence,
    deployment,
  };
}

export function newObservationLedger({
  deployment,
  startedAt,
  endedAt,
}) {
  return {
    schema: "agentpool.testnet.v44.observations/v1",
    observedChainId: 84532,
    release: deployment.release,
    sourceCommit: deployment.sourceCommit,
    deploymentManifestSha256: deployment.manifestSha256,
    startedAt,
    endedAt,
    observations: [],
    incidents: [],
    attestations: [],
    autonomyEvidence: {
      schema: "agentpool.v44.autonomy-evidence/v1",
      exposureLedger: newExposureLedger(),
      admissionBundles: [],
      settlementBundles: [],
      governanceEvents: [],
      checkpoints: [],
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

export function validateLedger(ledger, { policy, deployment }) {
  validateObservations(ledger, { policy, deployment });
  if (ledger.autonomyEvidence) {
    validateAutonomyEvidence(ledger.autonomyEvidence);
  }
  return ledger;
}
