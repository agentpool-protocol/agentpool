import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const envPath = path.join(root, ".env.v41.local");
const publicDirectory = path.join(root, "outputs", "testnet-wallets");
const publicPath = path.join(
  publicDirectory,
  "base-sepolia-v41-public-addresses.json",
);

if (fs.existsSync(envPath)) {
  throw new Error(
    ".env.v41.local already exists. Refusing to overwrite v4.1 wallet material.",
  );
}
if (!fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".env*")) {
  throw new Error(".gitignore must exclude .env files before wallet generation");
}

const deployerPrivateKey = generatePrivateKey();
const deployer = privateKeyToAccount(deployerPrivateKey);
const catalog = Array.from({ length: 5 }, () => {
  const privateKey = generatePrivateKey();
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
  };
}).sort((left, right) =>
  BigInt(left.address) < BigInt(right.address) ? -1 : 1,
);

const allAddresses = [deployer.address, ...catalog.map(({ address }) => address)];
if (
  new Set(allAddresses.map((address) => address.toLowerCase())).size !==
  allAddresses.length
) {
  throw new Error("Generated duplicate v4.1 testnet addresses");
}

const genesisStart = Math.floor(Date.now() / 1_000) + 1_800;
const envLines = [
  "# DISPOSABLE AGENTPOOL V4.1 BASE SEPOLIA KEYS. NEVER USE ON MAINNET.",
  "# This file is ignored by Git. Never paste its contents into chat.",
  "V41_WALLET_PROFILE=base-sepolia-disposable",
  `V41_DEPLOYER_PRIVATE_KEY=${deployerPrivateKey}`,
  "MIN_V41_DEPLOYER_BALANCE_WEI=30000000000000",
  ...catalog.map(
    ({ address }, index) => `V41_CATALOG_SIGNER_${index + 1}=${address}`,
  ),
  ...catalog.map(
    ({ privateKey }, index) =>
      `V41_CATALOG_SIGNER_PRIVATE_KEY_${index + 1}=${privateKey}`,
  ),
  `V41_GENESIS_TIMESTAMP=${genesisStart}`,
  `V41_CHALLENGE_SECRET=${randomBytes(32).toString("hex")}`,
  "",
];

fs.writeFileSync(envPath, envLines.join("\n"), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
fs.mkdirSync(publicDirectory, { recursive: true });
fs.writeFileSync(
  publicPath,
  `${JSON.stringify(
    {
      profile: "base-sepolia-disposable",
      chainId: 84532,
      network: "Base Sepolia",
      deployer: deployer.address,
      catalogSigners: catalog.map(({ address }) => address),
      catalogQuorum: 3,
      genesisStart,
      generatedAt: new Date().toISOString(),
      warning:
        "Disposable testnet identities only. Never send real ETH or valuable tokens.",
    },
    null,
    2,
  )}\n`,
  {
    encoding: "utf8",
    flag: "wx",
  },
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    network: "Base Sepolia",
    deployer: deployer.address,
    catalogSigners: catalog.map(({ address }) => address),
    catalogQuorum: 3,
    genesisStart,
    privateMaterial: ".env.v41.local",
    publicAddresses: publicPath,
  })}\n`,
);
