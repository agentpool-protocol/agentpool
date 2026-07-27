import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  V41_DEPLOYMENT,
  v41ChainClient,
} from "@/lib/v41-chain";

const bytes32 = { name: "assignmentId", type: "bytes32" } as const;

export const v41EpochVaultAbi = [
  {
    type: "function",
    name: "assignments",
    stateMutability: "view",
    inputs: [bytes32],
    outputs: [
      { name: "worker", type: "address" },
      { name: "reservedPayout", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "state", type: "uint8" },
      { name: "specificationHash", type: "bytes32" },
      { name: "expectedEvidenceHash", type: "bytes32" },
      { name: "payoutRoot", type: "bytes32" },
      { name: "artifactId", type: "bytes32" },
      { name: "provenanceHash", type: "bytes32" },
      { name: "licenseHash", type: "bytes32" },
      { name: "moduleId", type: "bytes32" },
      { name: "deliveryHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "openAssignment",
    stateMutability: "nonpayable",
    inputs: [
      bytes32,
      { name: "worker", type: "address" },
      { name: "reservedPayout", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "specificationHash", type: "bytes32" },
      { name: "expectedEvidenceHash", type: "bytes32" },
      { name: "payoutRoot", type: "bytes32" },
      { name: "artifactId", type: "bytes32" },
      { name: "provenanceHash", type: "bytes32" },
      { name: "licenseHash", type: "bytes32" },
      { name: "moduleId", type: "bytes32" },
      { name: "catalogSignatures", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "accept",
    stateMutability: "nonpayable",
    inputs: [bytes32],
    outputs: [],
  },
  {
    type: "function",
    name: "deliver",
    stateMutability: "nonpayable",
    inputs: [
      bytes32,
      { name: "deliveryHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      bytes32,
      { name: "proof", type: "bytes" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "artifactContentHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "expire",
    stateMutability: "nonpayable",
    inputs: [bytes32],
    outputs: [],
  },
  {
    type: "event",
    name: "AssignmentOpened",
    inputs: [
      { indexed: true, name: "assignmentId", type: "bytes32" },
      { indexed: true, name: "worker", type: "address" },
      { indexed: false, name: "reservedPayout", type: "uint256" },
      { indexed: false, name: "deadline", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "AssignmentAccepted",
    inputs: [{ indexed: true, name: "assignmentId", type: "bytes32" }],
  },
  {
    type: "event",
    name: "AssignmentDelivered",
    inputs: [
      { indexed: true, name: "assignmentId", type: "bytes32" },
      { indexed: false, name: "deliveryHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "AssignmentSettled",
    inputs: [
      { indexed: true, name: "assignmentId", type: "bytes32" },
      { indexed: false, name: "deliveryHash", type: "bytes32" },
      { indexed: false, name: "proofHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "AssignmentExpired",
    inputs: [{ indexed: true, name: "assignmentId", type: "bytes32" }],
  },
] as const;

const artifactRecordedEvent = {
  type: "event",
  name: "ArtifactRecorded",
  inputs: [
    { indexed: true, name: "artifactId", type: "bytes32" },
    { indexed: true, name: "assignmentId", type: "bytes32" },
    { indexed: true, name: "contentHash", type: "bytes32" },
    { indexed: false, name: "author", type: "address" },
  ],
} as const;

export type V41EpochAction = "ACCEPT" | "DELIVER" | "SETTLE" | "EXPIRE";

export function v41VaultForMarket(market: string): Address {
  if (market === "CAPABILITY") {
    return getAddress(V41_DEPLOYMENT.contracts.capabilityVault);
  }
  if (market === "BASIC") {
    return getAddress(V41_DEPLOYMENT.contracts.basicVault);
  }
  if (market === "VALIDATION") {
    return getAddress(V41_DEPLOYMENT.contracts.validationVault);
  }
  throw new Error("INVALID_V41_STATIC_VAULT_MARKET");
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchingLog(
  logs: readonly {
    address: Address;
    data: Hex;
    topics: [] | [Hex, ...Hex[]];
    logIndex: number;
  }[],
  vault: Address,
  eventName: string,
  assignmentId: Hex,
) {
  for (const log of logs) {
    if (!same(log.address, vault)) continue;
    try {
      const decoded = decodeEventLog({
        abi: v41EpochVaultAbi,
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === eventName &&
        "assignmentId" in decoded.args &&
        same(decoded.args.assignmentId, assignmentId)
      ) {
        return { log, decoded };
      }
    } catch {
      // A transaction may contain token and registry logs. Ignore non-vault logs.
    }
  }
  throw new Error(`INVALID_V41_${eventName.toUpperCase()}_EVENT`);
}

export async function verifyV41Award(input: {
  txHash: Hex;
  vault: Address;
  worker: Address;
  specificationHash: Hex;
  maxBudgetApool: string;
  maxDeadlineAt: number;
}) {
  const client = v41ChainClient();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: input.txHash }),
    client.getTransaction({ hash: input.txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    !receipt.to ||
    !transaction.to ||
    !same(receipt.to, input.vault) ||
    !same(transaction.to, input.vault)
  ) {
    throw new Error("INVALID_V41_AWARD_TRANSACTION");
  }
  const decoded = decodeFunctionData({
    abi: v41EpochVaultAbi,
    data: transaction.input,
  });
  if (decoded.functionName !== "openAssignment") {
    throw new Error("INVALID_V41_AWARD_CALLDATA");
  }
  const [
    assignmentId,
    worker,
    reservedPayout,
    deadline,
    specificationHash,
    expectedEvidenceHash,
    payoutRoot,
    artifactId,
    provenanceHash,
    licenseHash,
    moduleId,
  ] = decoded.args;
  const maxBudget = parseUnits(input.maxBudgetApool, V41_DEPLOYMENT.token.decimals);
  if (
    !same(worker, input.worker) ||
    !same(specificationHash, input.specificationHash) ||
    reservedPayout > maxBudget ||
    Number(deadline) * 1_000 > input.maxDeadlineAt
  ) {
    throw new Error("INVALID_V41_AWARD_TERMS");
  }
  if (reservedPayout % 10n ** BigInt(V41_DEPLOYMENT.token.decimals) !== 0n) {
    throw new Error("INVALID_V41_FRACTIONAL_AWARD");
  }
  const found = matchingLog(
    receipt.logs,
    input.vault,
    "AssignmentOpened",
    assignmentId,
  );
  if (
    found.decoded.eventName !== "AssignmentOpened" ||
    !same(found.decoded.args.worker, worker) ||
    found.decoded.args.reservedPayout !== reservedPayout ||
    found.decoded.args.deadline !== deadline
  ) {
    throw new Error("INVALID_V41_ASSIGNMENT_OPENED_EVENT");
  }
  return {
    assignmentId,
    worker: getAddress(worker),
    reservedPayout,
    reservedPayoutApool: formatUnits(
      reservedPayout,
      V41_DEPLOYMENT.token.decimals,
    ),
    deadline,
    specificationHash,
    expectedEvidenceHash,
    payoutRoot,
    artifactId,
    provenanceHash,
    licenseHash,
    moduleId,
    blockNumber: receipt.blockNumber,
    logIndex: found.log.logIndex,
    transactionFrom: getAddress(transaction.from),
  };
}

export async function verifyV41EpochAction(input: {
  txHash: Hex;
  vault: Address;
  assignmentId: Hex;
  action: V41EpochAction;
  worker: Address;
  expectedDeliveryHash?: Hex;
}) {
  const client = v41ChainClient();
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: input.txHash }),
    client.getTransaction({ hash: input.txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    !receipt.to ||
    !transaction.to ||
    !same(receipt.to, input.vault) ||
    !same(transaction.to, input.vault)
  ) {
    throw new Error("INVALID_V41_ACTION_TRANSACTION");
  }
  const decoded = decodeFunctionData({
    abi: v41EpochVaultAbi,
    data: transaction.input,
  });
  const expectedFunction = input.action.toLowerCase();
  if (
    decoded.functionName !== expectedFunction ||
    !same(decoded.args[0], input.assignmentId)
  ) {
    throw new Error("INVALID_V41_ACTION_CALLDATA");
  }
  if (
    (input.action === "ACCEPT" || input.action === "DELIVER") &&
    !same(transaction.from, input.worker)
  ) {
    throw new Error("INVALID_V41_ACTION_CALLER");
  }

  const eventNames: Record<V41EpochAction, string> = {
    ACCEPT: "AssignmentAccepted",
    DELIVER: "AssignmentDelivered",
    SETTLE: "AssignmentSettled",
    EXPIRE: "AssignmentExpired",
  };
  const eventName = eventNames[input.action];
  const found = matchingLog(
    receipt.logs,
    input.vault,
    eventName,
    input.assignmentId,
  );
  let deliveryHash: Hex | null = null;
  let proofHash: Hex | null = null;
  let artifact: {
    id: Hex;
    contentHash: Hex;
    provenanceHash: Hex;
    licenseHash: Hex;
    author: Address;
  } | null = null;
  if (input.action === "DELIVER") {
    const deliverArgs = decoded.args as readonly [Hex, Hex];
    deliveryHash = deliverArgs[1];
    if (
      !input.expectedDeliveryHash ||
      !same(deliveryHash, input.expectedDeliveryHash) ||
      found.decoded.eventName !== "AssignmentDelivered" ||
      !same(found.decoded.args.deliveryHash, deliveryHash)
    ) {
      throw new Error("INVALID_V41_DELIVERY_EVENT");
    }
  }
  if (input.action === "SETTLE") {
    const settleArgs = decoded.args as readonly [
      Hex,
      Hex,
      readonly Address[],
      readonly bigint[],
      Hex,
    ];
    const proof = settleArgs[1];
    proofHash = keccak256(proof);
    if (
      found.decoded.eventName !== "AssignmentSettled" ||
      !same(found.decoded.args.proofHash, proofHash)
    ) {
      throw new Error("INVALID_V41_SETTLEMENT_EVENT");
    }
    deliveryHash = found.decoded.args.deliveryHash;
    const onchainAssignment = await client.readContract({
      address: input.vault,
      abi: v41EpochVaultAbi,
      functionName: "assignments",
      args: [input.assignmentId],
    });
    const artifactId = onchainAssignment[7];
    const zeroHash = `0x${"0".repeat(64)}` as Hex;
    if (!same(artifactId, zeroHash)) {
      const artifactContentHash = settleArgs[4];
      for (const log of receipt.logs) {
        if (!same(log.address, V41_DEPLOYMENT.contracts.artifactRegistry)) {
          continue;
        }
        try {
          const decodedArtifact = decodeEventLog({
            abi: [artifactRecordedEvent],
            data: log.data,
            topics: log.topics,
          });
          if (
            same(decodedArtifact.args.artifactId, artifactId) &&
            same(decodedArtifact.args.assignmentId, input.assignmentId) &&
            same(decodedArtifact.args.contentHash, artifactContentHash) &&
            same(decodedArtifact.args.author, input.worker)
          ) {
            artifact = {
              id: artifactId,
              contentHash: artifactContentHash,
              provenanceHash: onchainAssignment[8],
              licenseHash: onchainAssignment[9],
              author: getAddress(decodedArtifact.args.author),
            };
            break;
          }
        } catch {
          // Ignore token and vault logs.
        }
      }
      if (!artifact) throw new Error("INVALID_V41_ARTIFACT_EVENT");
    }
  }
  return {
    blockNumber: receipt.blockNumber,
    logIndex: found.log.logIndex,
    transactionFrom: getAddress(transaction.from),
    deliveryHash,
    proofHash,
    artifact,
  };
}

export function buildV41AcceptTransaction(input: {
  vault: Address;
  assignmentId: Hex;
}) {
  return {
    chainId: 84532,
    to: input.vault,
    value: "0",
    data: encodeFunctionData({
      abi: v41EpochVaultAbi,
      functionName: "accept",
      args: [input.assignmentId],
    }),
  };
}

export function buildV41DeliverTransaction(input: {
  vault: Address;
  assignmentId: Hex;
  deliveryHash: Hex;
}) {
  return {
    chainId: 84532,
    to: input.vault,
    value: "0",
    data: encodeFunctionData({
      abi: v41EpochVaultAbi,
      functionName: "deliver",
      args: [input.assignmentId, input.deliveryHash],
    }),
  };
}

export function buildV41SettleTransaction(input: {
  vault: Address;
  assignmentId: Hex;
  proof: Hex;
  recipients: Address[];
  amountsApool: string[];
  artifactContentHash: Hex;
}) {
  const amounts = input.amountsApool.map((amount) =>
    parseUnits(amount, V41_DEPLOYMENT.token.decimals),
  );
  return {
    chainId: 84532,
    to: input.vault,
    value: "0",
    data: encodeFunctionData({
      abi: v41EpochVaultAbi,
      functionName: "settle",
      args: [
        input.assignmentId,
        input.proof,
        input.recipients,
        amounts,
        input.artifactContentHash,
      ],
    }),
  };
}

export async function validateV41SettlementTerms(input: {
  vault: Address;
  assignmentId: Hex;
  recipients: Address[];
  amountsApool: string[];
}) {
  const amounts = input.amountsApool.map((amount) =>
    parseUnits(amount, V41_DEPLOYMENT.token.decimals),
  );
  const assignment = await v41ChainClient().readContract({
    address: input.vault,
    abi: v41EpochVaultAbi,
    functionName: "assignments",
    args: [input.assignmentId],
  });
  const payoutRoot = keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [input.recipients, amounts],
    ),
  );
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (
    !same(payoutRoot, assignment[6]) ||
    total !== assignment[1] ||
    Number(assignment[3]) !== 3
  ) {
    throw new Error("INVALID_V41_SETTLEMENT_TERMS");
  }
  return {
    reservedPayout: assignment[1],
    payoutRoot: assignment[6],
    artifactId: assignment[7],
    deliveryHash: assignment[11],
  };
}
