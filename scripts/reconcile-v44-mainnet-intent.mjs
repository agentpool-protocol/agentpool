import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  CHAIN_ID,
  ROOT,
  assertTransactionMatchesIntent,
  attachTransactionHash,
  requireEnv,
} from "./lib/v44-mainnet.mjs";

const partialPath = path.join(ROOT, "deployments", "8453.v44.partial.json");
if (!fs.existsSync(partialPath)) {
  throw new Error("V44_PARTIAL_MANIFEST_MISSING");
}
const state = JSON.parse(fs.readFileSync(partialPath, "utf8"));
if (state.schemaVersion !== 2 || state.chainId !== CHAIN_ID) {
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
  chain: base,
  transport: http(requireEnv("AGENTPOOL_MAINNET_RPC_URL"), {
    timeout: 60_000,
    retryCount: 4,
  }),
});
if ((await client.getChainId()) !== CHAIN_ID) {
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
    chainId: CHAIN_ID,
    key,
    hash,
    nonce: intent.nonce,
    resumeCommand: "npm run contracts:deploy:v4.4:mainnet",
  })}\n`,
);
