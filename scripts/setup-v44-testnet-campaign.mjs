import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAddress, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ROOT,
  currentGitCommit,
  requireAddress,
  requireEnv,
  requireThresholdAuthorityConfig,
  sha256File,
} from "./lib/v44-mainnet.mjs";
import { resolveV44TestnetCampaignFiles } from "./lib/v44-chain-profile.mjs";
import { validateBootstrapSpecifications } from "./lib/v44-bootstrap-specifications.mjs";

const replace = process.argv.includes("--replace");
const mechanicsOnly = process.argv.includes("--mechanics-only");
function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}
const campaignId =
  argument("campaign") ??
  process.env.V44_TESTNET_CAMPAIGN_ID?.trim() ??
  null;
if (!campaignId) throw new Error("V44_TESTNET_CAMPAIGN_ID_REQUIRED");
const campaignFiles = resolveV44TestnetCampaignFiles({
  V44_TESTNET_CAMPAIGN_ID: campaignId,
});
const suppliedObjectives = argument("objectives");
const suppliedSpecifications = argument("specifications");
if (mechanicsOnly === Boolean(suppliedObjectives)) {
  throw new Error(
    "V44_TESTNET_SETUP_MODE_REQUIRED:choose --mechanics-only or --objectives=<path>",
  );
}
if (!mechanicsOnly && !suppliedSpecifications) {
  throw new Error("V44_TESTNET_SPECIFICATIONS_FILE_REQUIRED");
}
const environmentPath = path.join(ROOT, ".env.v44.testnet.local");
const objectivesPath = path.join(
  ROOT,
  `.testnet-v44-bootstrap-objectives.${campaignId}.local.json`,
);
for (const filePath of [
  environmentPath,
  ...(mechanicsOnly ? [objectivesPath] : []),
]) {
  if (fs.existsSync(filePath) && !replace) {
    throw new Error(`V44_TESTNET_SETUP_FILE_EXISTS:${filePath}`);
  }
}

const deployer = privateKeyToAccount(
  requireEnv("DEPLOYER_PRIVATE_KEY"),
).address;
const proposerKey =
  process.env.TESTNET_OPERATIONS_PRIVATE_KEY?.trim() ||
  process.env.TESTNET_AUTHOR_PRIVATE_KEY?.trim();
if (!proposerKey) {
  throw new Error("V44_TESTNET_BOOTSTRAP_PROPOSER_KEY_MISSING");
}
const proposer = privateKeyToAccount(proposerKey).address;
const validators = [1, 2, 3].map((index) =>
  requireAddress(`VALIDATOR_${index}`),
);
const worker = requireAddress("V44_BOOTSTRAP_WORKER");
const thresholdAuthority = requireThresholdAuthorityConfig();
const identities = [deployer, proposer, ...validators, worker].map((address) =>
  getAddress(address).toLowerCase(),
);
if (new Set(identities).size !== identities.length) {
  throw new Error("V44_TESTNET_SETUP_IDENTITIES_NOT_DISTINCT");
}

const randomBytes32 = () => `0x${crypto.randomBytes(32).toString("hex")}`;
const groupIds = [1, 2, 3].map(() => randomBytes32());
let selectedObjectivesPath;
let objectiveCount;
let reliabilityEligible;
let selectedSpecificationsPath = null;
let specificationsSha256 = null;
if (mechanicsOnly) {
  const objectives = Array.from({ length: 24 }, (_, index) => {
    const label = `AgentPool v4.4 bootstrap mechanics objective ${index + 1}`;
    return {
      capabilityHash: keccak256(toBytes(`${label}:capability`)),
      specificationHash: keccak256(toBytes(`${label}:specification`)),
      deliveryHash: randomBytes32(),
      objectiveProofHex: `0x${crypto.randomBytes(48).toString("hex")}`,
      capacityUnits: 100,
      mechanicsOnly: true,
      eligibleForReliability: false,
      eligibleForWorkPower: false,
    };
  });
  const catalog = {
    schema: "agentpool.mainnet.v44.bootstrap-objectives/v1",
    purpose:
      "Base Sepolia mechanics fixtures only; these generated objectives are not real improvements and are ineligible for reliability, Work Power, or mainnet readiness.",
    mechanicsOnly: true,
    eligibleForReliability: false,
    eligibleForWorkPower: false,
    objectives,
  };
  fs.writeFileSync(
    objectivesPath,
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
  selectedObjectivesPath = objectivesPath;
  objectiveCount = objectives.length;
  reliabilityEligible = false;
} else {
  selectedObjectivesPath = path.resolve(ROOT, suppliedObjectives);
  if (!fs.existsSync(selectedObjectivesPath)) {
    throw new Error("V44_TESTNET_OBJECTIVES_FILE_MISSING");
  }
  const catalog = JSON.parse(
    fs.readFileSync(selectedObjectivesPath, "utf8"),
  );
  if (
    catalog.schema !== "agentpool.mainnet.v44.bootstrap-objectives/v1" ||
    catalog.mechanicsOnly !== false ||
    catalog.eligibleForReliability !== true ||
    !Array.isArray(catalog.objectives) ||
    catalog.objectives.length < 24 ||
    catalog.objectives.length > 32 ||
    catalog.objectives.some(
      (entry) =>
        entry.mechanicsOnly !== false ||
        entry.eligibleForReliability !== true,
    )
  ) {
    throw new Error("V44_TESTNET_RELIABILITY_OBJECTIVES_INVALID");
  }
  objectiveCount = catalog.objectives.length;
  reliabilityEligible = true;
  selectedSpecificationsPath = path.resolve(ROOT, suppliedSpecifications);
  const sourceEvidence = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "outputs", "v44-source-reproducibility.json"),
      "utf8",
    ),
  );
  const specificationEvidence = validateBootstrapSpecifications({
    specificationsPath: selectedSpecificationsPath,
    objectiveCatalogPath: selectedObjectivesPath,
    sourceEvidence,
    campaignId,
  });
  specificationsSha256 = specificationEvidence.specificationsSha256;
}
const sourceCommit = currentGitCommit().toLowerCase();
const genesisStart = Math.floor(Date.now() / 1_000) + 4 * 86_400;
const lines = [
  "V44_TESTNET_ONLY_ACK=I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
  `V44_TESTNET_CAMPAIGN_ID=${campaignId}`,
  `AGENTPOOL_V44_TESTNET_RPC_URL=${
    process.env.AGENTPOOL_RPC_URL?.trim() || "https://sepolia.base.org"
  }`,
  "MIN_V44_TESTNET_DEPLOYER_BALANCE_WEI=500000000000000",
  `V44_SOURCE_COMMIT=${sourceCommit}`,
  "V44_SOURCE_EVIDENCE_FILE=outputs/v44-source-reproducibility.json",
  `V44_TESTNET_DEPLOYMENT_MANIFEST=${path.relative(ROOT, campaignFiles.deploymentPath)}`,
  `V44_TESTNET_CONTRACT_SOURCE_EVIDENCE=${path.relative(ROOT, campaignFiles.sourceEvidencePath)}`,
  `V44_TESTNET_OBSERVATIONS_FILE=${path.relative(ROOT, campaignFiles.observationsPath)}`,
  `V44_TESTNET_RELIABILITY_OUTPUT=${path.relative(ROOT, campaignFiles.reliabilityPath)}`,
  `V44_THRESHOLD_AUTHORITY_OWNERS=${thresholdAuthority.owners.join(",")}`,
  `V44_THRESHOLD_AUTHORITY_THRESHOLD=${thresholdAuthority.threshold}`,
  `V44_GENESIS_TIMESTAMP=${genesisStart}`,
  `V44_BOOTSTRAP_PROPOSER=${proposer}`,
  `V44_BOOTSTRAP_WORKER=${worker}`,
  ...validators.flatMap((address, index) => [
    `V44_VALIDATOR_${index + 1}=${address}`,
    `V44_VALIDATOR_${index + 1}_GROUP_ID=${groupIds[index]}`,
  ]),
  `V44_BOOTSTRAP_ISSUE_ID=${randomBytes32()}`,
  `V44_BOOTSTRAP_OBJECTIVES_FILE=${path.relative(ROOT, selectedObjectivesPath)}`,
  `V44_BOOTSTRAP_OBJECTIVES_SHA256=${sha256File(selectedObjectivesPath)}`,
  `V44_BOOTSTRAP_OBJECTIVE_MODE=${mechanicsOnly ? "mechanics-only" : "reliability"}`,
  ...(selectedSpecificationsPath
    ? [
        `V44_BOOTSTRAP_PUBLIC_SPECIFICATIONS_FILE=${path.relative(ROOT, selectedSpecificationsPath)}`,
        `V44_BOOTSTRAP_PUBLIC_SPECIFICATIONS_SHA256=${specificationsSha256}`,
      ]
    : []),
  `V44_GENESIS_MODULE_HASH=${randomBytes32()}`,
  `V44_GENESIS_MANIFEST_HASH=${randomBytes32()}`,
  "",
];
fs.writeFileSync(environmentPath, lines.join("\n"), "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      testnetOnly: true,
      chainId: 84532,
      campaignId,
      sourceCommit,
      deployer,
      proposer,
      validators,
      worker,
      thresholdAuthorityOwners: thresholdAuthority.owners,
      thresholdAuthorityThreshold: thresholdAuthority.threshold,
      genesisStart,
      objectiveCount,
      mechanicsOnly,
      reliabilityEligible,
      environmentPath,
      objectivesPath: selectedObjectivesPath,
      specificationsPath: selectedSpecificationsPath,
      specificationsSha256,
      privateKeysCopied: false,
      next: [
        "npm run evidence:v4.4:source",
        "npm run contracts:preflight:v4.4:testnet",
      ],
    },
    null,
    2,
  )}\n`,
);
