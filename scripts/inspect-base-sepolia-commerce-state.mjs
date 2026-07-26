import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.json"), "utf8"),
);
const tokenArtifact = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "AgentPoolToken.json"), "utf8"),
);
const escrowArtifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolProjectEscrow.json"),
    "utf8",
  ),
);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.AGENTPOOL_RPC_URL),
});
const buyer = manifest.allocations.ecosystemTreasury;
const escrow = manifest.contracts.projectEscrow;
const [allowance, balance, nonce, nextProjectId, nextTaskId] = await Promise.all([
  client.readContract({
    address: manifest.contracts.token,
    abi: tokenArtifact.abi,
    functionName: "allowance",
    args: [buyer, escrow],
  }),
  client.readContract({
    address: manifest.contracts.token,
    abi: tokenArtifact.abi,
    functionName: "balanceOf",
    args: [buyer],
  }),
  client.getTransactionCount({ address: buyer }),
  client.readContract({
    address: escrow,
    abi: escrowArtifact.abi,
    functionName: "nextProjectId",
  }),
  client.readContract({
    address: escrow,
    abi: escrowArtifact.abi,
    functionName: "nextTaskId",
  }),
]);

console.log(
  JSON.stringify(
    {
      buyer,
      escrow,
      allowance: allowance.toString(),
      balance: balance.toString(),
      nonce,
      nextProjectId: nextProjectId.toString(),
      nextTaskId: nextTaskId.toString(),
    },
    null,
    2,
  ),
);
