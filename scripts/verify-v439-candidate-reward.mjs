import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatUnits,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath =
  process.env.V439_DEPLOYMENT_MANIFEST?.trim() ??
  path.join(root, "deployments", "84532.v43.9.json");
if (!fs.existsSync(manifestPath)) throw new Error("V439_MANIFEST_MISSING");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 84_532 || manifest.testnetOnly !== true) {
  throw new Error("V439_MANIFEST_INVALID");
}
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL_MISSING");
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
if ((await client.getChainId()) !== 84_532) {
  throw new Error("V439_CHAIN_MISMATCH");
}
const artifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV439CandidateRewardPool.json"),
    "utf8",
  ),
);
const address = manifest.contracts.candidateRewardPool;
const read = (functionName) =>
  client.readContract({
    address,
    abi: artifact.abi,
    functionName,
  });
const [
  code,
  funded,
  reserved,
  paid,
  chainId,
  createsWorkPower,
  canRecommendRelease,
  canMint,
] = await Promise.all([
  client.getCode({ address }),
  read("totalFunded"),
  read("totalReserved"),
  read("totalPaid"),
  read("TESTNET_CHAIN_ID"),
  read("CREATES_WORK_POWER"),
  read("CAN_RECOMMEND_RELEASE"),
  read("CAN_MINT"),
]);
const checks = {
  codePresent: Boolean(code && code !== "0x"),
  chainBoundToBaseSepolia: chainId === 84_532n,
  fundedExactly: formatUnits(funded, 18) === manifest.caps.lifetimeApool,
  conservation:
    reserved + paid <= funded,
  createsNoWorkPower: createsWorkPower === false,
  cannotRecommendRelease: canRecommendRelease === false,
  cannotMint: canMint === false,
};
const report = {
  ok: Object.values(checks).every(Boolean),
  contract: address,
  fundedApool: formatUnits(funded, 18),
  reservedApool: formatUnits(reserved, 18),
  paidApool: formatUnits(paid, 18),
  checks,
  verifiedAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v439-candidate-reward-verification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
