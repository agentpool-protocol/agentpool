import { env } from "cloudflare:workers";
import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "@/deployment-config.json";

const benchmarkClaimEvent = {
  type: "event",
  name: "BenchmarkRewardClaimed",
  inputs: [
    { indexed: true, name: "challengeId", type: "bytes32" },
    { indexed: true, name: "minerId", type: "bytes32" },
    { indexed: true, name: "recipient", type: "address" },
    { indexed: false, name: "trackId", type: "bytes32" },
    { indexed: false, name: "leagueId", type: "bytes32" },
    { indexed: false, name: "reward", type: "uint256" },
  ],
} as const;

const transferEvent = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

const jobEscrowAbi = [
  {
    type: "function",
    name: "fundJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seller", type: "address" },
      { name: "price", type: "uint128" },
      { name: "sellerBond", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "requirementsHash", type: "bytes32" },
      { name: "verifierId", type: "bytes32" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "event",
    name: "JobFunded",
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "buyer", type: "address" },
      { indexed: true, name: "seller", type: "address" },
      { indexed: false, name: "price", type: "uint256" },
      { indexed: false, name: "validationFee", type: "uint256" },
    ],
  },
] as const;

const projectEscrowAbi = [
  {
    type: "function",
    name: "createProject",
    stateMutability: "nonpayable",
    inputs: [
      { name: "coordinator", type: "address" },
      { name: "maxWorkerBudget", type: "uint128" },
      { name: "minWorkers", type: "uint8" },
      { name: "maxTasks", type: "uint8" },
      { name: "deadline", type: "uint64" },
      { name: "briefHash", type: "bytes32" },
    ],
    outputs: [{ name: "projectId", type: "uint256" }],
  },
  {
    type: "event",
    name: "ProjectCreated",
    inputs: [
      { indexed: true, name: "projectId", type: "uint256" },
      { indexed: true, name: "buyer", type: "address" },
      { indexed: true, name: "coordinator", type: "address" },
      { indexed: false, name: "maxWorkerBudget", type: "uint256" },
      { indexed: false, name: "validationReserve", type: "uint256" },
      { indexed: false, name: "minWorkers", type: "uint256" },
    ],
  },
] as const;

export const DEPLOYMENT = deployment;

function runtimeRpcUrl(): string {
  const configured = (env as unknown as { AGENTPOOL_RPC_URL?: string })
    .AGENTPOOL_RPC_URL;
  return configured || deployment.fallbackRpcUrl;
}

export function chainClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(runtimeRpcUrl(), { timeout: 10_000 }),
  });
}

export function isTemporaryChainError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|fetch failed|network|rate limit|429|502|503|504|could not be found|not found|pending/iu.test(
    message,
  );
}

export async function chainStatus(): Promise<{
  blockNumber: bigint;
  timestamp: bigint;
}> {
  const block = await chainClient().getBlock();
  return { blockNumber: block.number, timestamp: block.timestamp };
}

export async function verifyBenchmarkClaim(input: {
  txHash: Hex;
  challengeId: Hex;
  minerId: Hex;
  recipient: Address;
  reward: bigint;
}): Promise<{ blockNumber: bigint; logIndex: number }> {
  const client = chainClient();
  const receipt = await client.getTransactionReceipt({ hash: input.txHash });
  if (
    receipt.status !== "success" ||
    receipt.to?.toLowerCase() !==
      deployment.contracts.benchmarkRewardVault.toLowerCase()
  ) {
    throw new Error("INVALID_CLAIM_TRANSACTION");
  }
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !==
      deployment.contracts.benchmarkRewardVault.toLowerCase()
    ) continue;
    try {
      const decoded = decodeEventLog({
        abi: [benchmarkClaimEvent],
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "BenchmarkRewardClaimed" &&
        decoded.args.challengeId.toLowerCase() === input.challengeId.toLowerCase() &&
        decoded.args.minerId.toLowerCase() === input.minerId.toLowerCase() &&
        decoded.args.recipient.toLowerCase() === input.recipient.toLowerCase() &&
        decoded.args.reward === input.reward
      ) {
        return {
          blockNumber: receipt.blockNumber,
          logIndex: log.logIndex,
        };
      }
    } catch {
      // Other logs in the receipt are intentionally ignored.
    }
  }
  throw new Error("INVALID_CLAIM_EVENT");
}

export async function verifyTokenTransfer(input: {
  txHash: Hex;
  from: Address;
  to: Address;
  amount: bigint;
}): Promise<{ blockNumber: bigint; logIndex: number }> {
  const receipt = await chainClient().getTransactionReceipt({
    hash: input.txHash,
  });
  if (receipt.status !== "success") {
    throw new Error("INVALID_PAYMENT_TRANSACTION");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== deployment.contracts.token.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "Transfer" &&
        decoded.args.from.toLowerCase() === input.from.toLowerCase() &&
        decoded.args.to.toLowerCase() === input.to.toLowerCase() &&
        decoded.args.value === input.amount
      ) {
        return {
          blockNumber: receipt.blockNumber,
          logIndex: log.logIndex,
        };
      }
    } catch {
      // Other token logs are intentionally ignored.
    }
  }
  throw new Error("INVALID_PAYMENT_EVENT");
}

export async function verifyJobFunding(input: {
  txHash: Hex;
  buyer: Address;
  seller: Address;
  price: bigint;
  sellerBond: bigint;
  deadline: bigint;
  requirementsHash: Hex;
  verifierId: Hex;
  validationFee: bigint;
}): Promise<{ blockNumber: bigint; logIndex: number; onchainJobId: bigint }> {
  const client = chainClient();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: input.txHash }),
    client.getTransaction({ hash: input.txHash }),
  ]);
  const escrow = deployment.contracts.jobEscrow.toLowerCase();
  if (
    receipt.status !== "success" ||
    receipt.to?.toLowerCase() !== escrow ||
    transaction.to?.toLowerCase() !== escrow ||
    transaction.from.toLowerCase() !== input.buyer.toLowerCase()
  ) {
    throw new Error("INVALID_JOB_FUNDING_TRANSACTION");
  }
  const decodedCall = decodeFunctionData({
    abi: jobEscrowAbi,
    data: transaction.input,
  });
  if (
    decodedCall.functionName !== "fundJob" ||
    decodedCall.args[0].toLowerCase() !== input.seller.toLowerCase() ||
    decodedCall.args[1] !== input.price ||
    decodedCall.args[2] !== input.sellerBond ||
    decodedCall.args[3] !== input.deadline ||
    decodedCall.args[4].toLowerCase() !== input.requirementsHash.toLowerCase() ||
    decodedCall.args[5].toLowerCase() !== input.verifierId.toLowerCase()
  ) {
    throw new Error("INVALID_JOB_FUNDING_CALLDATA");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrow) continue;
    try {
      const decoded = decodeEventLog({
        abi: jobEscrowAbi,
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "JobFunded" &&
        decoded.args.buyer.toLowerCase() === input.buyer.toLowerCase() &&
        decoded.args.seller.toLowerCase() === input.seller.toLowerCase() &&
        decoded.args.price === input.price &&
        decoded.args.validationFee === input.validationFee
      ) {
        return {
          blockNumber: receipt.blockNumber,
          logIndex: log.logIndex,
          onchainJobId: decoded.args.jobId,
        };
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("INVALID_JOB_FUNDING_EVENT");
}

export async function verifyProjectFunding(input: {
  txHash: Hex;
  buyer: Address;
  coordinator: Address;
  maxWorkerBudget: bigint;
  validationReserve: bigint;
  minWorkers: number;
  maxTasks: number;
  deadline: bigint;
  briefHash: Hex;
}): Promise<{ blockNumber: bigint; logIndex: number; onchainProjectId: bigint }> {
  const client = chainClient();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: input.txHash }),
    client.getTransaction({ hash: input.txHash }),
  ]);
  const escrow = deployment.contracts.projectEscrow.toLowerCase();
  if (
    receipt.status !== "success" ||
    receipt.to?.toLowerCase() !== escrow ||
    transaction.to?.toLowerCase() !== escrow ||
    transaction.from.toLowerCase() !== input.buyer.toLowerCase()
  ) {
    throw new Error("INVALID_PROJECT_FUNDING_TRANSACTION");
  }
  const decodedCall = decodeFunctionData({
    abi: projectEscrowAbi,
    data: transaction.input,
  });
  if (
    decodedCall.functionName !== "createProject" ||
    decodedCall.args[0].toLowerCase() !== input.coordinator.toLowerCase() ||
    decodedCall.args[1] !== input.maxWorkerBudget ||
    decodedCall.args[2] !== input.minWorkers ||
    decodedCall.args[3] !== input.maxTasks ||
    decodedCall.args[4] !== input.deadline ||
    decodedCall.args[5].toLowerCase() !== input.briefHash.toLowerCase()
  ) {
    throw new Error("INVALID_PROJECT_FUNDING_CALLDATA");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrow) continue;
    try {
      const decoded = decodeEventLog({
        abi: projectEscrowAbi,
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "ProjectCreated" &&
        decoded.args.buyer.toLowerCase() === input.buyer.toLowerCase() &&
        decoded.args.coordinator.toLowerCase() === input.coordinator.toLowerCase() &&
        decoded.args.maxWorkerBudget === input.maxWorkerBudget &&
        decoded.args.validationReserve === input.validationReserve &&
        decoded.args.minWorkers === BigInt(input.minWorkers)
      ) {
        return {
          blockNumber: receipt.blockNumber,
          logIndex: log.logIndex,
          onchainProjectId: decoded.args.projectId,
        };
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("INVALID_PROJECT_FUNDING_EVENT");
}
