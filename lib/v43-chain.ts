import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "@/deployments/84532.v43.5.json";
import selfBootstrapDeployment from "@/deployments/84532.v43.7.json";
import smoke from "@/deployments/84532.v43.5.smoke.json";
import tokenArtifact from "@/artifacts/AgentPoolV43Token.json";
import ledgerArtifact from "@/artifacts/AgentPoolV43ContributionLedger.json";
import vaultArtifact from "@/artifacts/AgentPoolV43EpochVault.json";
import registryArtifact from "@/artifacts/AgentPoolV43ReleaseRegistry.json";
import issueGateArtifact from "@/artifacts/AgentPoolV435SystemIssueGate.json";
import marketArtifact from "@/artifacts/AgentPoolV432TaskMarket.json";
import selfBootstrapArtifact from "@/artifacts/AgentPoolV437SelfBootstrapPool.json";

const PUBLIC_RPCS = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.drpc.org",
  "https://sepolia.base.org",
] as const;
const client = createPublicClient({
  chain: baseSepolia,
  transport: fallback(
    PUBLIC_RPCS.map((url) =>
      http(url, { batch: true, timeout: 8_000, retryCount: 1 }),
    ),
  ),
});

const contracts = deployment.contracts;
const EVENT_RANGE = 9_000n;
const RELEASE_STATES = [
  "NONE",
  "CANDIDATE",
  "PROVEN",
  "RECOMMENDED",
  "QUARANTINED",
];

async function read(
  address: string,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  return client.readContract({
    address: address as `0x${string}`,
    abi,
    functionName,
    args,
  } as never);
}

export const V43_DEPLOYMENT = deployment;
export const V437_DEPLOYMENT = selfBootstrapDeployment;
export const V43_SMOKE = smoke;

async function contractEvents(
  address: string,
  abi: readonly unknown[],
  fromBlock: bigint,
  toBlock: bigint,
) {
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += EVENT_RANGE) {
    ranges.push({
      fromBlock: start,
      toBlock:
        start + EVENT_RANGE - 1n > toBlock
          ? toBlock
          : start + EVENT_RANGE - 1n,
    });
  }
  const chunks = await Promise.all(
    ranges.map((range) =>
      client.getContractEvents({
        address: address as `0x${string}`,
        abi,
        ...range,
      } as never),
    ),
  );
  return chunks.flat() as Array<{
    eventName: string;
    args: Record<string, unknown>;
    transactionHash: string;
    blockNumber: bigint;
    logIndex: number;
  }>;
}

function serializableArgs(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}

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
      selfBootstrapOpen,
      selfBootstrapGraduated,
      selfBootstrapFunded,
      selfBootstrapReserved,
      selfBootstrapPaid,
      selfBootstrapBalance,
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
      read(
        selfBootstrapDeployment.contracts.selfBootstrapPool,
        selfBootstrapArtifact.abi,
        "selfBootstrapOpen",
      ),
      read(
        selfBootstrapDeployment.contracts.selfBootstrapPool,
        selfBootstrapArtifact.abi,
        "graduated",
      ),
      read(
        selfBootstrapDeployment.contracts.selfBootstrapPool,
        selfBootstrapArtifact.abi,
        "totalFunded",
      ),
      read(
        selfBootstrapDeployment.contracts.selfBootstrapPool,
        selfBootstrapArtifact.abi,
        "totalReserved",
      ),
      read(
        selfBootstrapDeployment.contracts.selfBootstrapPool,
        selfBootstrapArtifact.abi,
        "totalPaid",
      ),
      read(contracts.token, tokenArtifact.abi, "balanceOf", [
        selfBootstrapDeployment.contracts.selfBootstrapPool,
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
      selfBootstrap: {
        release: selfBootstrapDeployment.version,
        mode: "SELF_BOOTSTRAP",
        open: selfBootstrapOpen,
        graduated: selfBootstrapGraduated,
        contract:
          selfBootstrapDeployment.contracts.selfBootstrapPool,
        fundedApool: formatUnits(selfBootstrapFunded as bigint, 18),
        reservedApool: formatUnits(selfBootstrapReserved as bigint, 18),
        paidApool: formatUnits(selfBootstrapPaid as bigint, 18),
        availableApool: formatUnits(
          (selfBootstrapBalance as bigint) >
            (selfBootstrapReserved as bigint)
            ? (selfBootstrapBalance as bigint) -
                (selfBootstrapReserved as bigint)
            : 0n,
          18,
        ),
        caps: selfBootstrapDeployment.caps,
        sameAgentRolesAllowed: true,
        payoutRule: selfBootstrapDeployment.payoutRule,
        independenceClaim: false,
        createsWorkPower: false,
        canRecommendRelease: false,
        canMint: false,
      },
    };
  } catch (error) {
    const bootstrapIssue = deployment.bootstrapIssues[0];
    return {
      live: false,
      synchronization: "PENDING_CHAIN",
      chainId: 84532,
      phase: "UNKNOWN",
      blockNumber: null,
      totalSupplyApool: null,
      recommendedRelease: null,
      workPower: {
        eligibleAgents: 0,
        eligibleGroups: 0,
        successfulSettlements: "0",
        activeEpochs: 0,
        totalSuccessfulUnits: "0",
        largestGroupSuccessfulUnits: "0",
        maturityRequirements: deployment.maturity,
      },
      emission: {
        core: {
          epoch: null,
          emittedApool: null,
          reservedApool: null,
          weeklyCapApool: deployment.emission.coreWeeklyCapApool,
        },
        evolution: {
          epoch: null,
          emittedApool: null,
          reservedApool: null,
          weeklyCapApool: deployment.emission.evolutionWeeklyCapApool,
        },
      },
      bootstrapIssue: {
        ...bootstrapIssue,
        committedBudgetBaseUnits: "0",
        committedBudgetApool: null,
        candidatesUsed: 0,
      },
      selfBootstrap: {
        release: selfBootstrapDeployment.version,
        mode: "SELF_BOOTSTRAP",
        open: false,
        graduated: null,
        contract:
          selfBootstrapDeployment.contracts.selfBootstrapPool,
        fundedApool: null,
        reservedApool: null,
        paidApool: null,
        availableApool: null,
        caps: selfBootstrapDeployment.caps,
        independenceClaim: false,
        createsWorkPower: false,
        canRecommendRelease: false,
        canMint: false,
      },
      error: error instanceof Error ? error.message : "RPC unavailable",
    };
  }
}

export async function getV43Opportunities() {
  const chain = await getV43ChainStatus();
  const issue = deployment.bootstrapIssues[0];
  let jobs: Array<Record<string, unknown>> = [];
  let activity: Array<Record<string, unknown>> = [];
  let releases: Array<Record<string, unknown>> = [];
  let agents: Array<Record<string, unknown>> = [];
  let groups: Array<Record<string, unknown>> = [];
  let indexedFromBlock: string | null = null;
  let indexedToBlock: string | null = null;
  let indexerState = "PENDING_CHAIN";
  let indexerError: string | null = chain.live
    ? null
    : chain.error ?? "RPC unavailable";
  if (chain.live) {
    try {
      const deploymentReceipt = await client.getTransactionReceipt({
        hash: deployment.transactionHashes[0] as `0x${string}`,
      });
      const latest = await client.getBlockNumber();
      const fromBlock = deploymentReceipt.blockNumber;
      const [marketLogs, releaseLogs, contributionLogs] = await Promise.all([
        contractEvents(
          contracts.taskMarket,
          marketArtifact.abi,
          fromBlock,
          latest,
        ),
        contractEvents(
          contracts.releaseRegistry,
          registryArtifact.abi,
          fromBlock,
          latest,
        ),
        contractEvents(
          contracts.contributionLedger,
          ledgerArtifact.abi,
          fromBlock,
          latest,
        ),
      ]);
      indexedFromBlock = fromBlock.toString();
      indexedToBlock = latest.toString();
      indexerState = "SYNCED";
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
        marketLogs
          .filter((entry) => entry.eventName === "JobCreated")
          .slice(-50)
          .reverse()
          .map(async (entry) => {
            const jobId = entry.args.jobId as `0x${string}`;
            const job = (await read(
              contracts.taskMarket,
              marketArtifact.abi,
              "jobs",
              [jobId],
            )) as readonly unknown[];
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
      activity = marketLogs
        .filter((entry) =>
          [
            "JobCreated",
            "BudgetHeld",
            "JobReplanned",
            "MilestoneAccepted",
            "MilestoneDelivered",
            "MilestoneSettled",
            "JobClosed",
          ].includes(entry.eventName),
        )
        .slice(-100)
        .reverse()
        .map((entry) => ({
          event: entry.eventName,
          args: serializableArgs(entry.args),
          transactionHash: entry.transactionHash,
          blockNumber: entry.blockNumber.toString(),
          eventId: `${entry.transactionHash}:${entry.logIndex}`,
        }));
      releases = await Promise.all(
        releaseLogs
          .filter((entry) => entry.eventName === "ReleaseRegistered")
          .slice(-50)
          .reverse()
          .map(async (entry) => {
            const releaseId = entry.args.releaseId as `0x${string}`;
            const release = (await read(
              contracts.releaseRegistry,
              registryArtifact.abi,
              "releases",
              [releaseId],
            )) as readonly unknown[];
            return {
              releaseId,
              parent: release[0],
              moduleHash: release[1],
              manifestHash: release[2],
              registeredAt: Number(release[3]),
              state: RELEASE_STATES[Number(release[4])] ?? "UNKNOWN",
              recommended:
                String(releaseId).toLowerCase() ===
                String(chain.recommendedRelease).toLowerCase(),
              transactionHash: entry.transactionHash,
              blockNumber: entry.blockNumber.toString(),
            };
          }),
      );
      const registeredAgents = [
        ...new Set(
          contributionLogs
            .filter((entry) => entry.eventName === "AgentRegistered")
            .map((entry) => String(entry.args.agent).toLowerCase()),
        ),
      ];
      const contributionEpoch = (await read(
        contracts.contributionLedger,
        ledgerArtifact.abi,
        "currentEpoch",
      )) as bigint;
      agents = await Promise.all(
        registeredAgents.map(async (agent) => {
          const [profile, votingPower] = await Promise.all([
            read(
              contracts.contributionLedger,
              ledgerArtifact.abi,
              "profiles",
              [agent],
            ) as Promise<readonly unknown[]>,
            read(
              contracts.contributionLedger,
              ledgerArtifact.abi,
              "votingPowerAt",
              [agent, contributionEpoch, 8],
            ),
          ]);
          return {
            agent,
            operatorGroup: profile[0],
            runtimeHash: profile[1],
            registered: profile[2],
            votingPower: (votingPower as bigint).toString(),
          };
        }),
      );
      const groupTotals = new Map<string, bigint>();
      for (const agent of agents) {
        const operatorGroup = String(agent.operatorGroup);
        groupTotals.set(
          operatorGroup,
          (groupTotals.get(operatorGroup) ?? 0n) +
            BigInt(String(agent.votingPower)),
        );
      }
      groups = [...groupTotals.entries()]
        .map(([operatorGroup, votingPower]) => ({
          operatorGroup,
          votingPower: votingPower.toString(),
          agentCount: agents.filter(
            (agent) => String(agent.operatorGroup) === operatorGroup,
          ).length,
        }))
        .sort((a, b) =>
          BigInt(a.votingPower) === BigInt(b.votingPower)
            ? 0
            : BigInt(a.votingPower) > BigInt(b.votingPower)
              ? -1
              : 1,
        );
    } catch (error) {
      jobs = [];
      activity = [];
      releases = [];
      agents = [];
      groups = [];
      indexedFromBlock = null;
      indexedToBlock = null;
      indexerState = "PENDING_CHAIN";
      indexerError =
        error instanceof Error ? error.message : "Event replay unavailable";
    }
  }
  const totalBudgetCap = BigInt(issue.totalBudgetCap);
  const committedBudget = chain.live
    ? BigInt(chain.bootstrapIssue.committedBudgetBaseUnits)
    : 0n;
  return {
    chain,
    indexer: {
      state: indexerState,
      fromBlock: indexedFromBlock,
      toBlock: indexedToBlock,
      recovery: "permissionless-chain-replay",
      error: indexerError,
    },
    bootstrapIssue: {
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
    },
    jobs,
    activity,
    releases,
    workPowerDistribution: {
      agents,
      groups,
      note:
        "Operator-group identifiers are self-declared on this public testnet and are not proof of independent legal control.",
    },
  };
}
