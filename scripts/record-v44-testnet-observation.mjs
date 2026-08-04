import {
  appendTestnetObservation,
  argument,
  requiredArgument,
} from "./lib/v44-observation-ledger.mjs";
import { requireEnv } from "./lib/v44-mainnet.mjs";

const category = requiredArgument("category");
const txHash = requiredArgument("tx");
const rpcUrl = requireEnv("AGENTPOOL_V44_TESTNET_RPC_URL");
const result = await appendTestnetObservation({
  category,
  txHash,
  recordedBy: argument("recorded-by") ?? "permissionless",
  rpcUrl,
});
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      testnetOnly: true,
      ...result,
    },
    null,
    2,
  )}\n`,
);
