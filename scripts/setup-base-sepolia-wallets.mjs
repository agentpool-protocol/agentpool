import fs from "node:fs";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const envPath = path.join(root, ".env.local");
const publicOutputDirectory = path.join(root, "outputs", "testnet-wallets");
const publicOutputPath = path.join(publicOutputDirectory, "base-sepolia-public-addresses.json");

if (fs.existsSync(envPath)) {
  throw new Error(
    ".env.local already exists. Refusing to overwrite wallet material or deployment configuration.",
  );
}
if (!fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".env*")) {
  throw new Error(".gitignore must exclude .env files before wallet generation");
}

const roleDefinitions = [
  ["DEPLOYER", "DEPLOYER_PRIVATE_KEY"],
  ["GOVERNANCE_MULTISIG", "TESTNET_GOVERNANCE_PRIVATE_KEY"],
  ["ECOSYSTEM_TREASURY", "TESTNET_ECOSYSTEM_PRIVATE_KEY"],
  ["OPERATIONS_TREASURY", "TESTNET_OPERATIONS_PRIVATE_KEY"],
  ["VALIDATOR_TREASURY", "TESTNET_VALIDATOR_TREASURY_PRIVATE_KEY"],
  ["AUTHOR_TREASURY", "TESTNET_AUTHOR_PRIVATE_KEY"],
  ["LIQUIDITY_TREASURY", "TESTNET_LIQUIDITY_PRIVATE_KEY"],
  ["FOUNDER_BENEFICIARY", "TESTNET_FOUNDER_PRIVATE_KEY"],
  ["SECURITY_TREASURY", "TESTNET_SECURITY_PRIVATE_KEY"],
  ["INITIAL_VERIFIER_ADAPTER", "TESTNET_VERIFIER_PRIVATE_KEY"],
  ["VALIDATOR_1", "TESTNET_VALIDATOR_1_PRIVATE_KEY"],
  ["VALIDATOR_2", "TESTNET_VALIDATOR_2_PRIVATE_KEY"],
  ["VALIDATOR_3", "TESTNET_VALIDATOR_3_PRIVATE_KEY"],
  ["VALIDATOR_4", "TESTNET_VALIDATOR_4_PRIVATE_KEY"],
  ["VALIDATOR_5", "TESTNET_VALIDATOR_5_PRIVATE_KEY"],
];

const wallets = Object.fromEntries(
  roleDefinitions.map(([role, privateKeyName]) => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    return [role, { address: account.address, privateKey, privateKeyName }];
  }),
);
const addresses = Object.values(wallets).map(({ address }) => address.toLowerCase());
if (new Set(addresses).size !== addresses.length) {
  throw new Error("Generated duplicate testnet addresses");
}

const now = Math.floor(Date.now() / 1_000);
const activationTime = now + 3_600;
const verifierImplementationHash = keccak256(
  toBytes("agentpool-base-sepolia-disposable-verifier-v1"),
);
const envLines = [
  "# DISPOSABLE BASE SEPOLIA TEST KEYS. NEVER FUND WITH REAL ASSETS.",
  "# Generated locally. This file is ignored by Git and must never be pasted into chat.",
  "AGENTPOOL_WALLET_PROFILE=base-sepolia-disposable",
  "AGENTPOOL_CHAIN_ID=84532",
  "AGENTPOOL_RPC_URL=https://sepolia.base.org",
  `DEPLOYER_PRIVATE_KEY=${wallets.DEPLOYER.privateKey}`,
  "MIN_DEPLOYER_BALANCE_WEI=",
  "",
  ...roleDefinitions
    .filter(([role]) => role !== "DEPLOYER")
    .map(([role]) => `${role}=${wallets[role].address}`),
  `INITIAL_VERIFIER_IMPLEMENTATION_HASH=${verifierImplementationHash}`,
  "",
  `BENCHMARK_GENESIS_TIMESTAMP=${activationTime}`,
  "BENCHMARK_DAILY_CAP_APOOL=1000000",
  `FOUNDER_VESTING_START_TIMESTAMP=${activationTime}`,
  "PUBLIC_SITE_URL=https://agentpool-protocol.asfu.chatgpt.site",
  "",
  "# Test-only signing keys for the validator and verifier smoke-test runners.",
  ...roleDefinitions
    .filter(([role]) => role !== "DEPLOYER")
    .map(([, privateKeyName]) => `${privateKeyName}=${wallets[
      roleDefinitions.find((definition) => definition[1] === privateKeyName)[0]
    ].privateKey}`),
  "",
  "CHAINLINK_VRF_ADAPTER=",
  "MAINNET_AUDIT_REPORT_SHA256=",
  "MAINNET_LEGAL_MEMO_SHA256=",
  "MAINNET_TRADEMARK_EVIDENCE_SHA256=",
  "MAINNET_TESTNET_REPORT_SHA256=",
  "MAINNET_VALIDATOR_ECONOMICS_SHA256=",
  "MAINNET_MULTISIG_EVIDENCE_SHA256=",
  "",
];

fs.writeFileSync(envPath, envLines.join("\n"), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
fs.mkdirSync(publicOutputDirectory, { recursive: true });
const publicDocument = {
  profile: "base-sepolia-disposable",
  chainId: 84532,
  rpcUrl: "https://sepolia.base.org",
  explorerUrl: "https://sepolia-explorer.base.org",
  deployer: wallets.DEPLOYER.address,
  roles: Object.fromEntries(
    roleDefinitions
      .filter(([role]) => role !== "DEPLOYER")
      .map(([role]) => [role, wallets[role].address]),
  ),
  generatedAt: new Date().toISOString(),
  warning: "Disposable testnet identities only. Never send real ETH or valuable tokens.",
};
fs.writeFileSync(publicOutputPath, `${JSON.stringify(publicDocument, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

console.log(`Base Sepolia disposable deployer: ${wallets.DEPLOYER.address}`);
console.log(`Public addresses: ${publicOutputPath}`);
console.log("Private keys were written only to the gitignored .env.local file.");
