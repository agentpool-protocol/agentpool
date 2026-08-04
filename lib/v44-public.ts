import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "@/deployments/84532.v44.json";
import policy from "@/mainnet-v44-testnet-reliability-policy.json";
import tokenArtifact from "@/artifacts/AgentPoolV44Token.json";
import deploymentStages from "@/mainnet-v44-deployment-stages.json";
import twoRunnerCampaign from "@/v44-two-runner-campaign.json";

const RPC_PROVIDERS = [
  {
    id: "publicnode",
    url: "https://base-sepolia-rpc.publicnode.com",
  },
  {
    id: "base-foundation",
    url: "https://sepolia.base.org",
  },
] as const;

const client = createPublicClient({
  chain: baseSepolia,
  transport: fallback(
    RPC_PROVIDERS.map(({ url }) =>
      http(url, { batch: true, timeout: 8_000, retryCount: 1 }),
    ),
  ),
});

export const V44_DEPLOYMENT = deployment;
export const V44_RELIABILITY_POLICY = policy;
export const V44_DEPLOYMENT_STAGES = deploymentStages;
export const V44_TWO_RUNNER_CAMPAIGN = twoRunnerCampaign;

function genesisState(nowSeconds: number) {
  return nowSeconds < deployment.genesisStart
    ? "PRE_GENESIS"
    : deployment.phase;
}

export async function getV44PublicStatus() {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  try {
    const [chainId, blockNumber, totalSupply, tokenCode, marketCode] =
      await Promise.all([
        client.getChainId(),
        client.getBlockNumber(),
        client.readContract({
          address: deployment.contracts.token as `0x${string}`,
          abi: tokenArtifact.abi,
          functionName: "totalSupply",
        }),
        client.getCode({
          address: deployment.contracts.token as `0x${string}`,
        }),
        client.getCode({
          address: deployment.contracts.taskMarket as `0x${string}`,
        }),
      ]);
    if (chainId !== deployment.chainId) {
      throw new Error(`unexpected chain ${chainId}`);
    }
    const contractsPresent =
      Boolean(tokenCode && tokenCode !== "0x") &&
      Boolean(marketCode && marketCode !== "0x");
    return {
      reachable: true,
      synchronization: contractsPresent ? "SYNCED" : "CONTRACT_CODE_MISSING",
      chainId,
      blockNumber: blockNumber.toString(),
      phase: genesisState(nowSeconds),
      genesisStart: deployment.genesisStart,
      genesisStarted: nowSeconds >= deployment.genesisStart,
      totalSupplyTapool: formatUnits(totalSupply as bigint, 18),
      contractsPresent,
    };
  } catch (error) {
    return {
      reachable: false,
      synchronization: "PENDING_CHAIN",
      chainId: deployment.chainId,
      blockNumber: null,
      phase: genesisState(nowSeconds),
      genesisStart: deployment.genesisStart,
      genesisStarted: nowSeconds >= deployment.genesisStart,
      totalSupplyTapool: null,
      contractsPresent: false,
      error: error instanceof Error ? error.message : "unknown RPC error",
    };
  }
}

export function v44ReadinessBoundary() {
  return {
    mode: "READ_ONLY_ALPHA",
    publicWriteReady: false,
    deploymentStages: {
      current: "TWO_RUNNER_TESTNET_VERIFIED",
      engineeringEvidence: {
        verified: twoRunnerCampaign.eligible,
        sourceCommit: twoRunnerCampaign.sourceCommit,
        reportCount: twoRunnerCampaign.reportCount,
        runtimeFamilies: twoRunnerCampaign.runtimeFamilies,
        processInstanceCount: twoRunnerCampaign.processInstanceCount,
        engineeringEvidenceRoot: twoRunnerCampaign.engineeringEvidenceRoot,
        requiredRuntimeFamilies:
          deploymentStages.stages.TWO_RUNNER_TESTNET.minimumRuntimeFamilies,
        sameOperatorAllowed: true,
        sameDeviceAllowed: true,
        countsTowardIndependentOperators: false,
        countsTowardIndependentCustody: false,
      },
      dormantMainnet: {
        eligibleAfterTwoRunnerEvidence: true,
        eligibleNow: twoRunnerCampaign.dormantAnchorDeploymentEligible,
        allowedContracts:
          deploymentStages.stages.DORMANT_MAINNET.allowedContracts,
        tokenDeploymentAllowed: false,
        emissionAllowed: false,
        rewardAllowed: false,
        userDepositsAllowed: false,
        activationTransactionExists: false,
      },
      matureMainnet: {
        eligible: false,
        requiresSeparateDeployment: true,
        contributingAgentsRequired:
          deploymentStages.stages.MATURE_MAINNET.minimumContributingAgents,
        operatorGroupsRequired:
          deploymentStages.stages.MATURE_MAINNET.minimumOperatorGroups,
        independentCustodyRequired: true,
        everyExistingMainnetGateRequired: true,
      },
    },
    tamperEvidenceStatus: "PENDING_ANCHOR",
    policyActivationStatus:
      policy.autonomyV2.policyActivation.configurationStatus,
    rpcOperatorPolicyStatus:
      policy.autonomyV2.governanceEventProviderPolicy.configurationStatus,
    recoveryCryptographicThreshold: "NOT_DEPLOYED",
    recoveryCustodyDomains: 0,
    recoveryControllerDomains: 0,
    recoveryOperationalIndependence: false,
    independentControlDomains: 0,
    externalParticipantsObserved: 0,
    systemSettlementExposure: {
      successful: 0,
      reservedWorstCase: 0,
      automaticBootstrapMaximum: 49,
      allUnsettledStatesCountTowardMaximum: true,
      dynamicCandidatesPerIssue: 1,
      dynamicMilestonesPerSystemJob: 1,
      terminalFailuresReleaseActiveCapacityOnlyAfterFinalizedChainState: true,
      exposureStateRootVerified: false,
      admissionShadowBundleRequired: true,
      settlementShadowBundleRequired: true,
      uniqueExposureSlotRequired: true,
    },
    finality: {
      canonicalFinalizedHeadVerified: false,
      providerAgreement: false,
      providerIndependence: false,
      checkpointChainVerified: false,
      governanceContaminated: "UNVERIFIED",
    },
    reliabilityGate: {
      eligible: false,
      autonomyV2Status: "PENDING_NO_EVIDENCE",
      observationDaysRequired: policy.minimumObservationDays,
      verifiedTransactionsRequired: policy.minimumVerifiedTransactions,
      contributingAgentsRequired: policy.minimumContributingAgents,
      operatorGroupsRequired: policy.minimumContributingOperatorGroups,
      independentObserversRequired: policy.minimumIndependentObservers,
    },
    blockers: [
      "CHECKPOINT_ANCHOR_NOT_DEPLOYED",
      "METADATA_HEAD_ANCHOR_NOT_DEPLOYED",
      "RECOVERY_ROOT_NOT_ESTABLISHED",
      "INDEPENDENT_CUSTODY_NOT_ESTABLISHED",
      "EXTERNAL_CONTROL_DOMAINS_NOT_OBSERVED",
      "PUBLIC_RELIABILITY_CAMPAIGN_NOT_COMPLETE",
      "AUTONOMY_V2_EVIDENCE_NOT_COMPLETE",
      "POLICY_ACTIVATION_ANCHOR_NOT_PUBLISHED",
      "INDEPENDENT_RPC_OPERATORS_NOT_PINNED",
      "OBJECTIVE_MATURITY_READINESS_EVIDENCE_NOT_COMPLETE",
      "CURRENT_TESTNET_GRAPH_PREDATES_POLICY_ANCHOR",
      "DORMANT_ANCHOR_NOT_DEPLOYED",
      "MATURE_ECONOMY_REQUIRES_SEPARATE_GATED_DEPLOYMENT",
    ],
    candidateSafeguards: {
      ownerlessPolicyAnchorImplemented: true,
      policyAnchorDeployedOnCurrentPublicGraph: false,
      readinessCollectedFromTwoFinalizedRpcSnapshots: true,
      currentPublicGraphIsHistoricalReadOnlyAlpha: true,
      twoRunnerEngineeringEvidenceVerified: twoRunnerCampaign.eligible,
      sameOperatorEvidenceCountsAsIndependence: false,
    },
  };
}

export function v44OpportunityBoundary() {
  return {
    assignment: "agents-choose-by-expected-net-profit",
    forcedAssignment: false,
    genericBasicMining: false,
    externalJobsMintTapool: false,
    openWriteOpportunities: [],
    readOnlyOpportunities: [
      {
        id: "V44_DISCOVERY_AUDIT",
        market: "OBSERVATION",
        state: "OPEN_READ_ONLY",
        rewardTapool: "0",
        purpose:
          "Independently inspect the deployed contracts, manifests, and public readiness claims.",
      },
    ],
    blockedLanes: [
      {
        market: "SYSTEM_IMPROVEMENT",
        state: "BLOCKED_UNTIL_ADMISSION_AND_SETTLEMENT_EVIDENCE",
      },
      {
        market: "EXTERNAL",
        state: "BLOCKED_UNTIL_SAFE_PUBLIC_WRITE",
      },
      {
        market: "VALIDATION",
        state: "BLOCKED_UNTIL_INDEPENDENT_VALIDATORS",
      },
    ],
  };
}
