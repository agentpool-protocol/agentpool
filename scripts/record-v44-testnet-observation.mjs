import fs from "node:fs";
import {
  createPublicClient,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  collectLiveRpcEvidence,
} from "./lib/v44-testnet-reliability.mjs";
import {
  argument,
  loadLedgerContext,
  newObservationLedger,
  requiredArgument,
  validateLedger,
  writeJsonAtomic,
} from "./lib/v44-observation-ledger.mjs";
import { readJson, requireEnv } from "./lib/v44-mainnet.mjs";

const context = loadLedgerContext();
const category = requiredArgument("category");
const txHash = requiredArgument("tx").toLowerCase();
const rule = context.policyEvidence.policy.categories[category];
if (!rule) throw new Error(`V44_TESTNET_CATEGORY_UNKNOWN:${category}`);
if (!/^0x[0-9a-f]{64}$/u.test(txHash)) {
  throw new Error("V44_TESTNET_TX_HASH_INVALID");
}
const rpcUrl = requireEnv("AGENTPOOL_V44_TESTNET_RPC_URL");
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }),
});
if ((await client.getChainId()) !== 84532) {
  throw new Error("V44_TESTNET_RPC_CHAIN_MISMATCH");
}
const receipt = await client.getTransactionReceipt({ hash: txHash });
const block = await client.getBlock({ blockNumber: receipt.blockNumber });
const blockTime = new Date(Number(block.timestamp) * 1_000);
const existing = fs.existsSync(context.observationsPath)
  ? readJson(context.observationsPath)
  : newObservationLedger({
      deployment: context.deployment,
      policyEvidence: context.policyEvidence,
      evidencePipelineCommit: context.evidencePipelineCommit,
      startedAt: new Date(blockTime.getTime() - 1).toISOString(),
      endedAt: blockTime.toISOString(),
    });
if (
  existing.observations.some(
    (entry) => entry.txHash.toLowerCase() === txHash,
  )
) {
  throw new Error("V44_TESTNET_OBSERVATION_TX_REUSED");
}
const next = structuredClone(existing);
next.observations.push({
  category,
  txHash,
  contractKey: rule.contractKey,
  expectedStatus: rule.transactionStatus,
  blockNumber: Number(receipt.blockNumber),
  recordedBy: argument("recorded-by") ?? "permissionless",
});
next.endedAt = blockTime.toISOString();
if (Date.parse(next.endedAt) <= Date.parse(next.startedAt)) {
  next.startedAt = new Date(blockTime.getTime() - 1).toISOString();
}
// Every append changes the signed body, so stale observer signatures are
// deliberately removed. Observers sign only a frozen campaign snapshot.
next.attestations = [];
validateLedger(next, {
  policy: context.policyEvidence.policy,
  policySha256: context.policyEvidence.policySha256,
  deployment: context.deployment,
  evidencePipelineCommit: context.evidencePipelineCommit,
});
await collectLiveRpcEvidence({
  rpcUrl,
  deployment: context.deployment,
  observations: next,
  policy: context.policyEvidence.policy,
});
writeJsonAtomic(context.observationsPath, next);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      testnetOnly: true,
      category,
      txHash,
      blockNumber: Number(receipt.blockNumber),
      observationCount: next.observations.length,
      attestationsReset: true,
      observationsPath: context.observationsPath,
    },
    null,
    2,
  )}\n`,
);
