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
  defaultMinimumBalanceWei: "100000000000000",
  deployCommand: "npm run contracts:deploy:v4.4:testnet",
  requireReleaseGates: false,
  testnetOnly: true,
});

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
    return TESTNET;
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
