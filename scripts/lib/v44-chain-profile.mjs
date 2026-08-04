import fs from "node:fs";
import path from "node:path";
import { base, baseSepolia } from "viem/chains";
import { ROOT } from "./v44-mainnet.mjs";

const MAINNET = Object.freeze({
  id: "mainnet",
  chain: base,
  chainId: 8453,
  network: "Base",
  manifestSchema: "agentpool.mainnet.v44.deployment/v3",
  verificationSchema: "agentpool.mainnet.v44.verification/v1",
  manifestPath: path.join(ROOT, "deployments", "8453.v44.json"),
  partialPath: path.join(ROOT, "deployments", "8453.v44.partial.json"),
  verificationPath: path.join(
    ROOT,
    "outputs",
    "v44-base-mainnet-verification.json",
  ),
  rpcEnvironmentVariable: "AGENTPOOL_MAINNET_RPC_URL",
  minimumBalanceEnvironmentVariable: "MIN_V44_DEPLOYER_BALANCE_WEI",
  defaultMinimumBalanceWei: "10000000000000000",
  deployCommand: "npm run contracts:deploy:v4.4:mainnet",
  requireReleaseGates: true,
  testnetOnly: false,
});

const TESTNET = Object.freeze({
  id: "testnet",
  chain: baseSepolia,
  chainId: 84532,
  network: "Base Sepolia",
  manifestSchema: "agentpool.testnet.v44.deployment/v1",
  verificationSchema: "agentpool.testnet.v44.verification/v1",
  manifestPath: path.join(ROOT, "deployments", "84532.v44.json"),
  partialPath: path.join(ROOT, "deployments", "84532.v44.partial.json"),
  verificationPath: path.join(
    ROOT,
    "outputs",
    "v44-base-sepolia-verification.json",
  ),
  rpcEnvironmentVariable: "AGENTPOOL_V44_TESTNET_RPC_URL",
  minimumBalanceEnvironmentVariable:
    "MIN_V44_TESTNET_DEPLOYER_BALANCE_WEI",
  defaultMinimumBalanceWei: "1000000000000000",
  deployCommand: "npm run contracts:deploy:v4.4:testnet",
  requireReleaseGates: false,
  testnetOnly: true,
});

const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

function testnetCampaignProfile(campaignId) {
  if (!campaignId) return TESTNET;
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new Error("V44_TESTNET_CAMPAIGN_ID_INVALID");
  }
  const deploymentStem = `84532.v44.${campaignId}`;
  return Object.freeze({
    ...TESTNET,
    id: `testnet-${campaignId}`,
    campaignId,
    manifestPath: path.join(
      ROOT,
      "deployments",
      `${deploymentStem}.json`,
    ),
    partialPath: path.join(
      ROOT,
      "deployments",
      `${deploymentStem}.partial.json`,
    ),
    historicalSourceEvidencePath: path.join(
      ROOT,
      "deployments",
      `${deploymentStem}.source-reproducibility.json`,
    ),
    historicalBootstrapSpecificationsPath: path.join(
      ROOT,
      "deployments",
      `${deploymentStem}.bootstrap-specifications.json`,
    ),
    verificationPath: path.join(
      ROOT,
      "outputs",
      `v44-base-sepolia-verification.${campaignId}.json`,
    ),
  });
}

export function resolveV44TestnetCampaignFiles(env = process.env) {
  const campaignId = env.V44_TESTNET_CAMPAIGN_ID?.trim() || null;
  const profile = testnetCampaignProfile(campaignId);
  return Object.freeze({
    campaignId,
    deploymentPath: profile.manifestPath,
    sourceEvidencePath:
      profile.historicalSourceEvidencePath ??
      path.join(
        ROOT,
        "deployments",
        "84532.v44.source-reproducibility.json",
      ),
    observationsPath: path.join(
      ROOT,
      "outputs",
      campaignId
        ? `v44-public-testnet-observations.${campaignId}.json`
        : "v44-public-testnet-observations.json",
    ),
    reliabilityPath: path.join(
      ROOT,
      "outputs",
      campaignId
        ? `v44-public-testnet-reliability.${campaignId}.json`
        : "v44-public-testnet-reliability.json",
    ),
    verificationPath: profile.verificationPath,
    bootstrapSpecificationsPath:
      profile.historicalBootstrapSpecificationsPath ?? null,
  });
}

export function resolveV44ChainProfile(env = process.env) {
  const selected = env.V44_DEPLOYMENT_PROFILE?.trim() || "mainnet";
  if (selected === "mainnet") return MAINNET;
  if (selected === "testnet") {
    if (
      env.V44_TESTNET_ONLY_ACK?.trim() !==
      "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA"
    ) {
      throw new Error("V44_TESTNET_ONLY_ACK_REQUIRED");
    }
    return testnetCampaignProfile(
      env.V44_TESTNET_CAMPAIGN_ID?.trim() || null,
    );
  }
  throw new Error(`V44_DEPLOYMENT_PROFILE_INVALID:${selected}`);
}

export function requireProfileEnvironment(profile, env = process.env) {
  const rpcUrl = env[profile.rpcEnvironmentVariable]?.trim();
  if (!rpcUrl) {
    throw new Error(`${profile.rpcEnvironmentVariable}_MISSING`);
  }
  const minimumBalance = BigInt(
    env[profile.minimumBalanceEnvironmentVariable]?.trim() ||
      profile.defaultMinimumBalanceWei,
  );
  if (minimumBalance <= 0n) {
    throw new Error("V44_MINIMUM_DEPLOYER_BALANCE_INVALID");
  }
  return { rpcUrl, minimumBalance };
}

export async function requiredDeploymentBalance({
  profile,
  client,
  operatorFloor,
}) {
  if (!profile.testnetOnly) {
    return {
      requiredBalance: operatorFloor,
      operatorFloor,
      referenceCost: null,
      safetyMultiplier: null,
      referenceTransactionCount: null,
    };
  }
  const referencePath = path.join(ROOT, "deployments", "84532.v44.json");
  if (!fs.existsSync(referencePath)) {
    throw new Error("V44_TESTNET_GAS_REFERENCE_MISSING");
  }
  const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
  if (
    reference.chainId !== 84532 ||
    !Array.isArray(reference.transactionHashes) ||
    reference.transactionHashes.length < 20 ||
    new Set(reference.transactionHashes).size !==
      reference.transactionHashes.length
  ) {
    throw new Error("V44_TESTNET_GAS_REFERENCE_INVALID");
  }
  let referenceCost = 0n;
  for (const hash of reference.transactionHashes) {
    const receipt = await client.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (!receipt || receipt.status !== "0x1") {
      throw new Error("V44_TESTNET_GAS_REFERENCE_RECEIPT_INVALID");
    }
    referenceCost +=
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
      BigInt(receipt.l1Fee ?? 0);
  }
  const safetyMultiplier = 5n;
  const absoluteFloor = 500_000_000_000_000n;
  const evidenceFloor = referenceCost * safetyMultiplier;
  const requiredBalance = [operatorFloor, absoluteFloor, evidenceFloor].reduce(
    (maximum, value) => (value > maximum ? value : maximum),
    0n,
  );
  return {
    requiredBalance,
    operatorFloor,
    referenceCost,
    safetyMultiplier,
    referenceTransactionCount: reference.transactionHashes.length,
  };
}
