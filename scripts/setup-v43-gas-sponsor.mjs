#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = path.resolve(import.meta.dirname, "..");
const secretPath = path.join(root, ".env.gas-sponsor.local");
const publicPath = path.join(
  root,
  "deployments",
  "84532.v43.8.gas-sponsor.json",
);

function existingPrivateKey() {
  if (!fs.existsSync(secretPath)) return null;
  const match = fs
    .readFileSync(secretPath, "utf8")
    .match(
      /^AGENTPOOL_V43_GAS_SPONSOR_PRIVATE_KEY=(0x[a-fA-F0-9]{64})$/mu,
    );
  if (!match) {
    throw new Error("V43_GAS_SPONSOR_LOCAL_SECRET_INVALID");
  }
  return match[1];
}

const priorPrivateKey = existingPrivateKey();
const privateKey = priorPrivateKey ?? generatePrivateKey();
const account = privateKeyToAccount(privateKey);
if (!fs.existsSync(secretPath)) {
  fs.writeFileSync(
    secretPath,
    [
      "# Base Sepolia testnet gas sponsor only.",
      "# Never commit, paste into chat, or reuse this key on mainnet.",
      `AGENTPOOL_V43_GAS_SPONSOR_PRIVATE_KEY=${privateKey}`,
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

const publicRecord = {
  protocol: "AgentPool",
  release: "v4.3.8-gas-onboarding-alpha",
  chainId: 84532,
  network: "Base Sepolia",
  testnetOnly: true,
  sponsorAddress: account.address,
  custody: "site-secret-only",
  privateKeyPublished: false,
  grantTargetEth: "0.000003",
  grantsPerAddressPerUtcDay: 1,
  globalDailyGrantCountCap: 100,
  globalDailyEthCap: "0.0003",
  mainnetAllowed: false,
};
fs.writeFileSync(
  publicPath,
  `${JSON.stringify(publicRecord, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      reusedExistingSecret: priorPrivateKey !== null,
      sponsorAddress: account.address,
      secretPath,
      publicPath,
      next:
        "Fund this address with Base Sepolia test ETH, then configure the same local secret as the Sites environment secret.",
    },
    null,
    2,
  )}\n`,
);
