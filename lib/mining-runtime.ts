import { env } from "cloudflare:workers";
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainClient, DEPLOYMENT } from "@/lib/chain";

export const MINING_SESSION_TTL_MS = 20 * 60 * 1_000;
export const OPERATIONAL_DAILY_CAP_APOOL = 10_000;
export const OPERATIONAL_ACCOUNT_DAILY_CAP_APOOL = 500;
export const MAX_ACTIVE_SESSIONS = 3;

const receiptTypes = {
  RewardReceipt: [
    { name: "challengeId", type: "bytes32" },
    { name: "submissionHash", type: "bytes32" },
    { name: "minerId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "trackId", type: "bytes32" },
    { name: "leagueId", type: "bytes32" },
    { name: "policyVersion", type: "uint32" },
    { name: "accuracyBps", type: "uint16" },
    { name: "efficiencyBps", type: "uint16" },
    { name: "baseReward", type: "uint128" },
    { name: "reward", type: "uint128" },
    { name: "day", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const benchmarkVaultAbi = [
  {
    type: "function",
    name: "genesis",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "policyVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipt",
        type: "tuple",
        components: receiptTypes.RewardReceipt,
      },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

export type PublicMiningTrack = "data" | "math" | "api";

export interface MiningChallengePayload {
  version: 1;
  challengeId: Hex;
  track: PublicMiningTrack;
  task: Record<string, unknown>;
  expectedAnswer: unknown;
  salt: string;
  createdAt: number;
  expiresAt: number;
}

export interface RewardReceipt {
  challengeId: Hex;
  submissionHash: Hex;
  minerId: Hex;
  recipient: Address;
  trackId: Hex;
  leagueId: Hex;
  policyVersion: number;
  accuracyBps: number;
  efficiencyBps: number;
  baseReward: bigint;
  reward: bigint;
  day: bigint;
  expiresAt: bigint;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashJson(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}

function randomInt(min: number, max: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return min + (buffer[0] % (max - min + 1));
}

export function generateChallenge(
  track: PublicMiningTrack,
  challengeId: Hex,
  now = Date.now(),
): MiningChallengePayload {
  const expiresAt = now + MINING_SESSION_TTL_MS;
  const salt = crypto.randomUUID();
  if (track === "math") {
    const left = randomInt(11, 97);
    const right = randomInt(7, 43);
    const offset = randomInt(3, 29);
    return {
      version: 1,
      challengeId,
      track,
      task: {
        instruction: "Return the integer result of left * right + offset.",
        left,
        right,
        offset,
      },
      expectedAnswer: { result: left * right + offset },
      salt,
      createdAt: now,
      expiresAt,
    };
  }
  if (track === "api") {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: `row-${index + 1}`,
      quantity: randomInt(1, 8),
      unitPrice: randomInt(20, 120),
    }));
    return {
      version: 1,
      challengeId,
      track,
      task: {
        instruction: "Return lineTotals in row order and grandTotal.",
        rows,
      },
      expectedAnswer: {
        lineTotals: rows.map((row) => ({
          id: row.id,
          total: row.quantity * row.unitPrice,
        })),
        grandTotal: rows.reduce(
          (sum, row) => sum + row.quantity * row.unitPrice,
          0,
        ),
      },
      salt,
      createdAt: now,
      expiresAt,
    };
  }
  const values = Array.from({ length: 7 }, () => randomInt(1, 50));
  const sortedUnique = [...new Set(values)].sort((a, b) => a - b);
  return {
    version: 1,
    challengeId,
    track,
    task: {
      instruction:
        "Sort the integers, remove duplicates, and return sortedUnique plus weightedChecksum = sum(value * oneBasedIndex).",
      values,
    },
    expectedAnswer: {
      sortedUnique,
      weightedChecksum: sortedUnique.reduce(
        (sum, value, index) => sum + value * (index + 1),
        0,
      ),
    },
    salt,
    createdAt: now,
    expiresAt,
  };
}

export function publicChallenge(payload: MiningChallengePayload) {
  return {
    challengeId: payload.challengeId,
    track: payload.track,
    task: payload.task,
    expiresAt: payload.expiresAt,
  };
}

export function challengeCommitment(payload: MiningChallengePayload): Hex {
  return hashJson(payload);
}

export function baseRewardFor(track: PublicMiningTrack): number {
  if (track === "math") return 40;
  if (track === "api") return 80;
  return 60;
}

function validatorKeys(): Hex[] {
  const runtime = env as unknown as Record<string, string | undefined>;
  return [1, 2, 3, 4, 5]
    .map((index) => runtime[`TESTNET_VALIDATOR_${index}_PRIVATE_KEY`])
    .filter((value): value is string => Boolean(value))
    .map((value) => value as Hex);
}

export async function createSignedReward(input: {
  challengeId: Hex;
  submissionHash: Hex;
  minerAgentId: string;
  recipient: Address;
  track: PublicMiningTrack;
  baseReward: number;
}): Promise<{
  receipt: RewardReceipt;
  signatures: Hex[];
  calldata: Hex;
}> {
  const keys = validatorKeys();
  if (keys.length < 3) {
    throw new Error("VALIDATOR_QUORUM_UNAVAILABLE");
  }
  const client = chainClient();
  const vault = DEPLOYMENT.contracts.benchmarkRewardVault as Address;
  const [block, genesis, policyVersion] = await Promise.all([
    client.getBlock(),
    client.readContract({
      address: vault,
      abi: benchmarkVaultAbi,
      functionName: "genesis",
    }),
    client.readContract({
      address: vault,
      abi: benchmarkVaultAbi,
      functionName: "policyVersion",
    }),
  ]);
  if (block.timestamp < genesis) {
    throw new Error("MINING_NOT_STARTED");
  }
  const receipt: RewardReceipt = {
    challengeId: input.challengeId,
    submissionHash: input.submissionHash,
    minerId: keccak256(toBytes(input.minerAgentId)),
    recipient: input.recipient,
    trackId: keccak256(toBytes(input.track === "api" ? "data" : input.track)),
    leagueId: keccak256(toBytes("api")),
    policyVersion: Number(policyVersion),
    accuracyBps: 10_000,
    efficiencyBps: 0,
    baseReward: BigInt(input.baseReward),
    reward: BigInt(input.baseReward),
    day: (block.timestamp - genesis) / 86_400n,
    expiresAt: block.timestamp + 3_600n,
  };
  const signatures = await Promise.all(
    keys.slice(0, 3).map((key) =>
      privateKeyToAccount(key).signTypedData({
        domain: {
          name: "AgentPool Benchmark Mining",
          version: "2",
          chainId: DEPLOYMENT.chainId,
          verifyingContract: vault,
        },
        types: receiptTypes,
        primaryType: "RewardReceipt",
        message: receipt,
      }),
    ),
  );
  return {
    receipt,
    signatures,
    calldata: encodeFunctionData({
      abi: benchmarkVaultAbi,
      functionName: "claim",
      args: [receipt, signatures],
    }),
  };
}
