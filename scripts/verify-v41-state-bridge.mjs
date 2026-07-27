import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  http,
  keccak256,
  parseUnits,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const deployment = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const smoke = JSON.parse(
  fs.readFileSync(
    path.join(root, "deployments", "84532.v41.smoke.json"),
    "utf8",
  ),
);
const vaultArtifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV41EpochVault.json"),
    "utf8",
  ),
);
const tokenArtifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV41Token.json"),
    "utf8",
  ),
);
const rpcUrl = process.env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
if ((await client.getChainId()) !== 84532) {
  throw new Error("V41_BRIDGE_CHAIN_MISMATCH");
}

const expected = [
  ["openAssignment", "AssignmentOpened"],
  ["accept", "AssignmentAccepted"],
  ["deliver", "AssignmentDelivered"],
  ["settle", "AssignmentSettled"],
];
const checks = [];
const same = (left, right) => left.toLowerCase() === right.toLowerCase();

for (let index = 0; index < smoke.transactionHashes.length; index += 1) {
  const hash = smoke.transactionHashes[index];
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  const [functionName, eventName] = expected[index];
  checks.push({
    name: `${functionName}.successfulVaultCall`,
    passed:
      receipt.status === "success" &&
      receipt.to &&
      same(receipt.to, smoke.vault) &&
      transaction.to &&
      same(transaction.to, smoke.vault),
  });
  const decodedCall = decodeFunctionData({
    abi: vaultArtifact.abi,
    data: transaction.input,
  });
  checks.push({
    name: `${functionName}.exactCalldata`,
    passed:
      decodedCall.functionName === functionName &&
      same(decodedCall.args[0], smoke.assignmentId),
  });
  if (functionName === "accept" || functionName === "deliver") {
    checks.push({
      name: `${functionName}.workerCaller`,
      passed: same(transaction.from, smoke.recipients[0]),
    });
  }
  let matchingEvent = null;
  for (const log of receipt.logs) {
    if (!same(log.address, smoke.vault)) continue;
    try {
      const decoded = decodeEventLog({
        abi: vaultArtifact.abi,
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === eventName &&
        same(decoded.args.assignmentId, smoke.assignmentId)
      ) {
        matchingEvent = decoded;
        break;
      }
    } catch {
      // Ignore unrelated registry and token logs.
    }
  }
  checks.push({
    name: `${functionName}.exactEvent`,
    passed: matchingEvent !== null,
  });
  if (functionName === "deliver") {
    checks.push({
      name: "deliver.hashMatchesEvent",
      passed:
        matchingEvent &&
        same(decodedCall.args[1], matchingEvent.args.deliveryHash),
    });
  }
  if (functionName === "settle") {
    checks.push({
      name: "settle.proofHashMatchesEvent",
      passed:
        matchingEvent &&
        same(keccak256(decodedCall.args[1]), matchingEvent.args.proofHash),
    });
  }
}

const [assignment, supply] = await Promise.all([
  client.readContract({
    address: smoke.vault,
    abi: vaultArtifact.abi,
    functionName: "assignments",
    args: [smoke.assignmentId],
  }),
  client.readContract({
    address: smoke.token,
    abi: tokenArtifact.abi,
    functionName: "totalSupply",
  }),
]);
checks.push({
  name: "final.assignmentSettled",
  passed: Number(assignment[3]) === 4,
});
const smokePayout = smoke.payoutApool.reduce(
  (total, amount) =>
    total + parseUnits(amount, deployment.token.decimals),
  0n,
);
checks.push({
  name: "final.assignmentPayoutExact",
  passed: assignment[1] === smokePayout,
});
checks.push({
  name: "final.supplyIncludesHistoricalSettlement",
  passed:
    supply >= parseUnits(smoke.totalMintedApool, deployment.token.decimals),
});

const report = {
  ok: checks.every((check) => check.passed),
  chainId: 84532,
  assignmentId: smoke.assignmentId,
  transactionHashes: smoke.transactionHashes,
  checks,
};
if (!report.ok) {
  throw new Error(`V41_BRIDGE_VERIFICATION_FAILED:${JSON.stringify(report)}`);
}
process.stdout.write(
  `${JSON.stringify({ ok: true, checks: checks.length, assignmentId: smoke.assignmentId })}\n`,
);
