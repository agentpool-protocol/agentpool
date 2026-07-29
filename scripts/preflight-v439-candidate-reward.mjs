import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeDeployData,
  formatEther,
  formatUnits,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const parent = JSON.parse(
  fs.readFileSync(
    path.join(root, "deployments", "84532.v43.5.json"),
    "utf8",
  ),
);
const pool = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV439CandidateRewardPool.json"),
    "utf8",
  ),
);
const token = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43Token.json"),
    "utf8",
  ),
);
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const deployerKey = (
  process.env.V439_DEPLOYER_PRIVATE_KEY ??
  process.env.DEPLOYER_PRIVATE_KEY
)?.trim();
const funderKey = (
  process.env.V439_FUNDER_PRIVATE_KEY ??
  process.env.TESTNET_AUTHOR_PRIVATE_KEY
)?.trim();
if (!rpcUrl || !deployerKey || !funderKey) {
  throw new Error("V439_PREFLIGHT_ENV_MISSING");
}
const deployer = privateKeyToAccount(deployerKey);
const funder = privateKeyToAccount(funderKey);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
if ((await client.getChainId()) !== 84_532) {
  throw new Error("V439_CHAIN_MISMATCH");
}
const args = [
  parent.contracts.token,
  parent.contracts.contributionLedger,
  parseEther("0.5"),
  parseEther("2"),
  parseEther("0.5"),
  parseEther("5"),
  parseEther("5"),
  parseEther("5"),
  8_000,
  1,
  1,
  8,
  5,
  7 * 86_400,
];
const data = encodeDeployData({
  abi: pool.abi,
  bytecode: pool.bytecode,
  args,
});
const [estimatedGas, gasPrice, deployerBalance, funderBalance, funderToken] =
  await Promise.all([
    client.estimateGas({ account: deployer.address, data }),
    client.getGasPrice(),
    client.getBalance({ address: deployer.address }),
    client.getBalance({ address: funder.address }),
    client.readContract({
      address: parent.contracts.token,
      abi: token.abi,
      functionName: "balanceOf",
      args: [funder.address],
    }),
  ]);
const estimatedCost = estimatedGas * gasPrice;
const minimumDeployBalance = (estimatedCost * 125n) / 100n;
// Approval and funding are separate transactions. The pool address does not
// exist yet, so use a deliberately conservative bound instead of pretending
// that any positive ETH balance is sufficient.
const minimumFunderBalance = (250_000n * gasPrice * 125n) / 100n;
const report = {
  ok:
    deployerBalance >= minimumDeployBalance &&
    funderToken >= parseEther("5") &&
    funderBalance >= minimumFunderBalance,
  chainId: 84_532,
  deployer: {
    address: deployer.address,
    balanceEth: formatEther(deployerBalance),
    estimatedDeploymentCostEth: formatEther(estimatedCost),
    minimumWithBufferEth: formatEther(minimumDeployBalance),
    ready: deployerBalance >= minimumDeployBalance,
  },
  funder: {
    address: funder.address,
    balanceEth: formatEther(funderBalance),
    balanceApool: formatUnits(funderToken, 18),
    minimumGasBalanceEth: formatEther(minimumFunderBalance),
    tokenReady: funderToken >= parseEther("5"),
    gasReady: funderBalance >= minimumFunderBalance,
  },
  runtimeBytes: (pool.deployedBytecode.length - 2) / 2,
  testnetOnly: true,
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v439-candidate-reward-preflight.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 2;
