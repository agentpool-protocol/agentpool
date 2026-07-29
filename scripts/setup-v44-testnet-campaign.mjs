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
  sha256File,
} from "./lib/v44-mainnet.mjs";

const replace = process.argv.includes("--replace");
const environmentPath = path.join(ROOT, ".env.v44.testnet.local");
const objectivesPath = path.join(
  ROOT,
  ".testnet-v44-bootstrap-objectives.local.json",
);
for (const filePath of [environmentPath, objectivesPath]) {
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
const identities = [deployer, proposer, ...validators].map((address) =>
  getAddress(address).toLowerCase(),
);
if (new Set(identities).size !== identities.length) {
  throw new Error("V44_TESTNET_SETUP_IDENTITIES_NOT_DISTINCT");
}

const randomBytes32 = () => `0x${crypto.randomBytes(32).toString("hex")}`;
const groupIds = [1, 2, 3].map(() => randomBytes32());
const objectives = Array.from({ length: 24 }, (_, index) => {
  const label = `AgentPool v4.4 bootstrap reliability objective ${index + 1}`;
  return {
    capabilityHash: keccak256(toBytes(`${label}:capability`)),
    specificationHash: keccak256(toBytes(`${label}:specification`)),
    deliveryHash: randomBytes32(),
    objectiveProofHex: `0x${crypto.randomBytes(48).toString("hex")}`,
    capacityUnits: 100,
  };
});
const catalog = {
  schema: "agentpool.mainnet.v44.bootstrap-objectives/v1",
  purpose:
    "Base Sepolia reliability campaign only; objective answers remain local until settlement.",
  objectives,
};
fs.writeFileSync(
  objectivesPath,
  `${JSON.stringify(catalog, null, 2)}\n`,
  "utf8",
);
const sourceCommit = currentGitCommit().toLowerCase();
const genesisStart = Math.floor(Date.now() / 1_000) + 4 * 86_400;
const lines = [
  "V44_TESTNET_ONLY_ACK=I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA",
  `AGENTPOOL_V44_TESTNET_RPC_URL=${
    process.env.AGENTPOOL_RPC_URL?.trim() || "https://sepolia.base.org"
  }`,
  "MIN_V44_TESTNET_DEPLOYER_BALANCE_WEI=1000000000000000",
  `V44_SOURCE_COMMIT=${sourceCommit}`,
  "V44_SOURCE_EVIDENCE_FILE=outputs/v44-source-reproducibility.json",
  `V44_GENESIS_TIMESTAMP=${genesisStart}`,
  `V44_BOOTSTRAP_PROPOSER=${proposer}`,
  ...validators.flatMap((address, index) => [
    `V44_VALIDATOR_${index + 1}=${address}`,
    `V44_VALIDATOR_${index + 1}_GROUP_ID=${groupIds[index]}`,
  ]),
  `V44_BOOTSTRAP_ISSUE_ID=${randomBytes32()}`,
  "V44_BOOTSTRAP_OBJECTIVES_FILE=.testnet-v44-bootstrap-objectives.local.json",
  `V44_BOOTSTRAP_OBJECTIVES_SHA256=${sha256File(objectivesPath)}`,
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
      sourceCommit,
      deployer,
      proposer,
      validators,
      genesisStart,
      objectiveCount: objectives.length,
      environmentPath,
      objectivesPath,
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
