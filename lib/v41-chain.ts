import { env } from "cloudflare:workers";
import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "@/deployments/84532.v41.json";
import smoke from "@/deployments/84532.v41.smoke.json";

const tokenAbi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_SUPPLY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const controllerAbi = [
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "epochAllowance",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint64" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "epochMinted",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint64" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "epochReserved",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint64" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "genesisMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "genesisReserved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const V41_DEPLOYMENT = deployment;
export const V41_SMOKE = smoke;

function rpcUrl(): string {
  return (
    (env as unknown as { AGENTPOOL_RPC_URL?: string }).AGENTPOOL_RPC_URL ||
    "https://sepolia.base.org"
  );
}

export function v41ChainClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl(), { timeout: 10_000 }),
  });
}

export async function v41ChainStatus(): Promise<{
  blockNumber: string;
  blockTimestamp: string;
  currentEpoch: number;
  totalSupplyApool: string;
  maxSupplyApool: string;
  epochAllowanceApool: string;
  epochMintedApool: string;
  epochReservedApool: string;
  epochRemainingApool: string;
  genesisMintedApool: string;
  genesisReservedApool: string;
}> {
  const client = v41ChainClient();
  const addresses = Object.values(deployment.contracts) as Address[];
  const [block, ...bytecodes] = await Promise.all([
    client.getBlock(),
    ...addresses.map((address) => client.getBytecode({ address })),
  ]);
  if (bytecodes.some((bytecode) => !bytecode || bytecode === "0x")) {
    throw new Error("V41_DEPLOYMENT_BYTECODE_MISSING");
  }

  const token = deployment.contracts.token as Address;
  const controller = deployment.contracts.controller as Address;
  const [totalSupply, maxSupply, currentEpoch, genesisMinted, genesisReserved] =
    await Promise.all([
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "totalSupply",
      }),
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "MAX_SUPPLY",
      }),
      client.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "currentEpoch",
      }),
      client.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "genesisMinted",
      }),
      client.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "genesisReserved",
      }),
    ]);
  const [allowance, minted, reserved] = await Promise.all([
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "epochAllowance",
      args: [currentEpoch],
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "epochMinted",
      args: [currentEpoch],
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "epochReserved",
      args: [currentEpoch],
    }),
  ]);
  const remaining = allowance > minted + reserved
    ? allowance - minted - reserved
    : 0n;
  const apool = (value: bigint) => formatUnits(value, deployment.token.decimals);

  return {
    blockNumber: block.number.toString(),
    blockTimestamp: block.timestamp.toString(),
    currentEpoch: Number(currentEpoch),
    totalSupplyApool: apool(totalSupply),
    maxSupplyApool: apool(maxSupply),
    epochAllowanceApool: apool(allowance),
    epochMintedApool: apool(minted),
    epochReservedApool: apool(reserved),
    epochRemainingApool: apool(remaining),
    genesisMintedApool: apool(genesisMinted),
    genesisReservedApool: apool(genesisReserved),
  };
}
