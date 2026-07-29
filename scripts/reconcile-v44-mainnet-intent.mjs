import fs from "node:fs";
import { createPublicClient, http } from "viem";
import {
  assertTransactionMatchesIntent,
  attachTransactionHash,
  requireEnv,
} from "./lib/v44-mainnet.mjs";
import { resolveV44ChainProfile } from "./lib/v44-chain-profile.mjs";

const profile = resolveV44ChainProfile({
  ...process.env,
  V44_DEPLOYMENT_PROFILE: process.argv.includes("--testnet")
    ? "testnet"
    : "mainnet",
});
const { partialPath } = profile;
if (!fs.existsSync(partialPath)) {
  throw new Error("V44_PARTIAL_MANIFEST_MISSING");
}
const state = JSON.parse(fs.readFileSync(partialPath, "utf8"));
if (
  state.schemaVersion !== 3 ||
  state.chainId !== profile.chainId ||
  (state.deploymentProfile ?? "mainnet") !== profile.id
) {
  throw new Error("V44_PARTIAL_MANIFEST_INVALID");
}

const key = requireEnv("V44_RECONCILE_INTENT_KEY");
const hash = requireEnv("V44_RECONCILE_TX_HASH");
if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
  throw new Error("V44_RECONCILE_TX_HASH_INVALID");
}
const intent = state.transactionIntents?.[key];
if (!intent || intent.hash) {
  throw new Error(`V44_RECONCILE_INTENT_NOT_UNCERTAIN:${key}`);
}

const client = createPublicClient({
  chain: profile.chain,
  transport: http(requireEnv(profile.rpcEnvironmentVariable), {
    timeout: 60_000,
    retryCount: 4,
  }),
});
if ((await client.getChainId()) !== profile.chainId) {
  throw new Error("V44_RECONCILE_CHAIN_MISMATCH");
}
const transaction = await client.getTransaction({ hash });
assertTransactionMatchesIntent({
  key,
  intent,
  expectedFrom: state.deployer,
  transaction,
});
attachTransactionHash({ intents: state.transactionIntents, key, hash });

if (key.startsWith("deploy:")) {
  const contractKey = key.slice("deploy:".length);
  state.deploymentTransactions[contractKey] = hash;
  state.creationInputHashes[contractKey] = intent.inputHash;
} else if (key.startsWith("configure:")) {
  const step = key.slice("configure:".length);
  state.configurationTransactions[step] = hash;
  state.configurationInputHashes[step] = intent.inputHash;
} else {
  throw new Error(`V44_RECONCILE_INTENT_KIND_INVALID:${key}`);
}
state.transactionHashes = [
  ...new Set([...(state.transactionHashes ?? []), hash]),
];
state.updatedAt = new Date().toISOString();
fs.writeFileSync(partialPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    deploymentProfile: profile.id,
    testnetOnly: profile.testnetOnly,
    chainId: profile.chainId,
    key,
    hash,
    nonce: intent.nonce,
    resumeCommand: profile.deployCommand,
  })}\n`,
);
