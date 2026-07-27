import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const recoveryPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : null;
const recoveryRoot = path.resolve(root, "outputs", "recovery");
if (
  !recoveryPath ||
  !recoveryPath.startsWith(`${recoveryRoot}${path.sep}`) ||
  !fs.existsSync(recoveryPath)
) {
  throw new Error("V41_RECOVERY_FILE_REQUIRED");
}
const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
if (
  recovery.chainId !== 84532 ||
  recovery.transactionHashes?.fund ||
  process.env.V41_WALLET_PROFILE !== "base-sepolia-disposable"
) {
  throw new Error("V41_RECOVERY_REQUIRES_UNFUNDED_DISPOSABLE_JOB");
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const tokenAbi = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "AgentPoolV41Token.json"), "utf8"),
).abi;
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL is required");
const worker = privateKeyToAccount(recovery.privateKey);
if (worker.address.toLowerCase() !== recovery.worker.toLowerCase()) {
  throw new Error("V41_RECOVERY_WORKER_MISMATCH");
}
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const workerClient = createWalletClient({
  account: worker,
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const balance = await publicClient.readContract({
  address: manifest.contracts.token,
  abi: tokenAbi,
  functionName: "balanceOf",
  args: [worker.address],
});
let sweepHash = null;
if (balance > 0n) {
  sweepHash = await workerClient.writeContract({
    address: manifest.contracts.token,
    abi: tokenAbi,
    functionName: "transfer",
    args: [manifest.deployer, balance],
    gas: 100_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: sweepHash,
  });
  if (receipt.status !== "success") {
    throw new Error("V41_RECOVERY_SWEEP_FAILED");
  }
}
let finalBalance;
for (let attempt = 0; attempt < 30; attempt += 1) {
  finalBalance = await publicClient.readContract({
    address: manifest.contracts.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [worker.address],
  });
  if (finalBalance === 0n) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (finalBalance !== 0n) throw new Error("V41_RECOVERY_BALANCE_REMAINS");
fs.rmSync(recoveryPath);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    worker: worker.address,
    recoveredTo: manifest.deployer,
    sweepHash,
  })}\n`,
);
