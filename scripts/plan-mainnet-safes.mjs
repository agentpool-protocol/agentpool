import fs from "node:fs";
import path from "node:path";
import Safe from "@safe-global/protocol-kit";
import { getAddress, keccak256, toBytes } from "viem";

const root = process.cwd();
if (process.env.AGENTPOOL_OWNER_PROFILE !== "production") {
  throw new Error(
    "Set AGENTPOOL_OWNER_PROFILE=production only after creating real, independent public signer addresses",
  );
}
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const rpcUrl =
  process.env.AGENTPOOL_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org";
const owners = Array.from({ length: 3 }, (_, index) =>
  getAddress(requireEnv(`SAFE_OWNER_${index + 1}`)),
);
if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) {
  throw new Error("All three Safe owners must be distinct");
}

const safeVersion = "1.4.1";
const threshold = 2;
const roles = [
  "founder",
  "governance",
  "ecosystem",
  "operations",
  "validator",
  "author",
  "liquidity",
  "security",
];
const safes = {};
for (const role of roles) {
  const saltNonce = BigInt(
    keccak256(toBytes(`agentpool-base-mainnet-${role}-safe-v1`)),
  ).toString();
  const kit = await Safe.init({
    provider: rpcUrl,
    signer: owners[0],
    predictedSafe: {
      safeAccountConfig: { owners, threshold },
      safeDeploymentConfig: { saltNonce, safeVersion },
    },
  });
  safes[role] = {
    address: await kit.getAddress(),
    deployed: await kit.isSafeDeployed(),
    owners,
    threshold,
    safeVersion,
    saltNonce,
  };
}
const addresses = Object.values(safes).map((safe) =>
  safe.address.toLowerCase(),
);
if (new Set(addresses).size !== addresses.length) {
  throw new Error("Predicted Safe addresses are not unique");
}
if (Object.values(safes).some((safe) => safe.deployed)) {
  throw new Error(
    "One or more predicted Safes already exist; review the plan before proceeding",
  );
}

const plan = {
  version: 1,
  status: "planned_not_deployed",
  chainId: 8453,
  network: "Base Mainnet",
  founderBeneficiary: safes.founder.address,
  owners,
  safes,
  createdAt: new Date().toISOString(),
  warning:
    "This file contains public addresses only and does not authorize mainnet deployment.",
};
const outputPath = path.join(root, "outputs", "production-safe-plan.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(`Founder beneficiary Safe: ${safes.founder.address}`);
for (const [role, safe] of Object.entries(safes)) {
  console.log(`${role}: ${safe.address} (${threshold}-of-${owners.length})`);
}
console.log(`Plan written to ${outputPath}`);
