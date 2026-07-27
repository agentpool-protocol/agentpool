import {
  createPublicClient,
  formatUnits,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "@/deployments/84532.v43.4.json";
import smoke from "@/deployments/84532.v43.4.smoke.json";
import tokenArtifact from "@/artifacts/AgentPoolV43Token.json";
import ledgerArtifact from "@/artifacts/AgentPoolV43ContributionLedger.json";
import vaultArtifact from "@/artifacts/AgentPoolV43EpochVault.json";
import registryArtifact from "@/artifacts/AgentPoolV43ReleaseRegistry.json";
import issueGateArtifact from "@/artifacts/AgentPoolV432SystemIssueGate.json";
import marketArtifact from "@/artifacts/AgentPoolV432TaskMarket.json";

const DEFAULT_RPC = "https://sepolia.base.org";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(DEFAULT_RPC, { timeout: 8_000, retryCount: 2 }),
});

const contracts = deployment.contracts;

async function read(
  address: string,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<any> {
  return client.readContract({
    address: address as `0x${string}`,
    abi,
    functionName,
    args,
  } as never);
}

export const V43_DEPLOYMENT = deployment;
export const V43_SMOKE = smoke;

export async function getV43ChainStatus() {
  try {
    const bootstrapIssue = deployment.bootstrapIssues[0];
    const [
      chainId,
      blockNumber,
      totalSupply,
      mature,
      eligibleAgents,
      eligibleGroups,
      successfulSettlements,
      activeEpochs,
      totalSuccessfulUnits,
      largestGroupSuccessfulUnits,
      recommendedRelease,
      coreEpoch,
      evolutionEpoch,
      coreEmitted,
      coreReserved,
      evolutionEmitted,
      evolutionReserved,
      issueUsage,
    ] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      read(contracts.token, tokenArtifact.abi, "totalSupply"),
      read(contracts.contributionLedger, ledgerArtifact.abi, "mature"),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "eligibleAgentCount",
      ),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "eligibleGroupCount",
      ),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "successfulSettlementCount",
      ),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "activeEpochCount",
      ),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "totalSuccessfulUnits",
      ),
      read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "largestGroupSuccessfulUnits",
      ),
      read(
        contracts.releaseRegistry,
        registryArtifact.abi,
        "recommendedRelease",
      ),
      read(contracts.coreEpochVault, vaultArtifact.abi, "currentEpoch"),
      read(contracts.evolutionEpochVault, vaultArtifact.abi, "currentEpoch"),
      read(contracts.coreEpochVault, vaultArtifact.abi, "totalEmitted"),
      read(contracts.coreEpochVault, vaultArtifact.abi, "totalReserved"),
      read(contracts.evolutionEpochVault, vaultArtifact.abi, "totalEmitted"),
      read(contracts.evolutionEpochVault, vaultArtifact.abi, "totalReserved"),
      read(contracts.systemIssueGate, issueGateArtifact.abi, "usage", [
        bootstrapIssue.issueId,
      ]),
    ]);
    if (chainId !== 84532) throw new Error(`wrong chain ${chainId}`);
    return {
      live: true,
      synchronization: "SYNCED",
      chainId,
      blockNumber: blockNumber.toString(),
      phase: mature ? "MATURE" : "BOOTSTRAP",
      totalSupplyApool: formatUnits(totalSupply as bigint, 18),
      recommendedRelease,
      workPower: {
        eligibleAgents,
        eligibleGroups,
        successfulSettlements: (successfulSettlements as bigint).toString(),
        activeEpochs,
        totalSuccessfulUnits: (totalSuccessfulUnits as bigint).toString(),
        largestGroupSuccessfulUnits: (
          largestGroupSuccessfulUnits as bigint
        ).toString(),
        maturityRequirements: deployment.maturity,
      },
      emission: {
        core: {
          epoch: (coreEpoch as bigint).toString(),
          emittedApool: formatUnits(coreEmitted as bigint, 18),
          reservedApool: formatUnits(coreReserved as bigint, 18),
          weeklyCapApool: deployment.emission.coreWeeklyCapApool,
        },
        evolution: {
          epoch: (evolutionEpoch as bigint).toString(),
          emittedApool: formatUnits(evolutionEmitted as bigint, 18),
          reservedApool: formatUnits(evolutionReserved as bigint, 18),
          weeklyCapApool: deployment.emission.evolutionWeeklyCapApool,
        },
      },
      bootstrapIssue: {
        ...bootstrapIssue,
        committedBudgetBaseUnits: (issueUsage[1] as bigint).toString(),
        committedBudgetApool: formatUnits(issueUsage[1] as bigint, 18),
        candidatesUsed: Number(issueUsage[2]),
      },
    };
  } catch (error) {
    return {
      live: false,
      synchronization: "PENDING_CHAIN",
      chainId: 84532,
      phase: "UNKNOWN",
      error: error instanceof Error ? error.message : "RPC unavailable",
    };
  }
}

export async function getV43Opportunities() {
  const chain = await getV43ChainStatus();
  const issue = deployment.bootstrapIssues[0];
  let jobs: Array<Record<string, unknown>> = [];
  let indexedFromBlock: string | null = null;
  let indexedToBlock: string | null = null;
  if (chain.live) {
    try {
      const deploymentReceipt = await client.getTransactionReceipt({
        hash: deployment.transactionHashes[0] as `0x${string}`,
      });
      const latest = await client.getBlockNumber();
      const fromBlock = deploymentReceipt.blockNumber;
      const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
      for (let start = fromBlock; start <= latest; start += 9_000n) {
        ranges.push({
          fromBlock: start,
          toBlock: start + 8_999n > latest ? latest : start + 8_999n,
        });
      }
      const chunks = await Promise.all(
        ranges.map((range) =>
          client.getContractEvents({
            address: contracts.taskMarket as `0x${string}`,
            abi: marketArtifact.abi,
            eventName: "JobCreated",
            ...range,
          }),
        ),
      );
      const logs = chunks.flat();
      indexedFromBlock = fromBlock.toString();
      indexedToBlock = latest.toString();
      const stateNames = [
        "NONE",
        "OPEN",
        "RUNNING",
        "BUDGET_HOLD",
        "SETTLED",
        "REJECTED",
        "REFUNDED",
        "EXPIRED",
      ];
      jobs = await Promise.all(
        logs.slice(-50).reverse().map(async (entry) => {
          const jobId = (entry.args as { jobId: `0x${string}` }).jobId;
          const job = await read(
            contracts.taskMarket,
            marketArtifact.abi,
            "jobs",
            [jobId],
          );
          return {
            jobId,
            creator: job[0],
            funding:
              Number(job[1]) === 1
                ? "EXTERNAL"
                : Number(job[1]) === 2
                  ? "CORE"
                  : "EVOLUTION",
            state: stateNames[Number(job[2])] ?? "UNKNOWN",
            planHash: job[3],
            releaseId: job[4],
            issueId: job[5],
            budgetApool: formatUnits(job[6], 18),
            paidApool: formatUnits(job[7], 18),
            transactionHash: entry.transactionHash,
            blockNumber: entry.blockNumber.toString(),
          };
        }),
      );
    } catch {
      jobs = [];
    }
  }
  const totalBudgetCap = BigInt(issue.totalBudgetCap);
  const committedBudget = chain.live
    ? BigInt(chain.bootstrapIssue.committedBudgetBaseUnits)
    : 0n;
  return {
    chain,
    indexer: {
      state: chain.live ? "SYNCED" : "PENDING_CHAIN",
      fromBlock: indexedFromBlock,
      toBlock: indexedToBlock,
      recovery: "permissionless-chain-replay",
    },
    bootstrapIssue: chain.live
      ? {
          ...chain.bootstrapIssue,
          remainingCandidates:
            issue.maxCandidates - Number(chain.bootstrapIssue.candidatesUsed),
          remainingBudgetApool: formatUnits(
            totalBudgetCap > committedBudget
              ? totalBudgetCap - committedBudget
              : 0n,
            18,
          ),
          candidateBudgetCapApool: formatUnits(
            BigInt(issue.candidateBudgetCap),
            18,
          ),
          totalBudgetCapApool: formatUnits(
            BigInt(issue.totalBudgetCap),
            18,
          ),
        }
      : issue,
    jobs,
  };
}
