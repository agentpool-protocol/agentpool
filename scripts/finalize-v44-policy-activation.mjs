import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  artifact,
  readJson,
} from "./lib/v44-mainnet.mjs";
import {
  loadLedgerContext,
  newObservationLedger,
  writeJsonAtomic,
} from "./lib/v44-observation-ledger.mjs";
import {
  autonomyPolicyIdentity,
  collectPolicyActivationPublicationSnapshot,
  reconcilePolicyActivationPublicationSnapshots,
  validateObservations,
} from "./lib/v44-testnet-reliability.mjs";
import { validatePolicyActivationPackage } from "./lib/v44-policy-activation-workflow.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function providerOperator(policy, rpcUrl) {
  const origin = new URL(rpcUrl).origin;
  const provider = policy.governanceEventProviderPolicy.providers.find(
    (candidate) => candidate.allowedOrigins.includes(origin),
  );
  if (!provider) throw new Error("V44_POLICY_ACTIVATION_RPC_NOT_PINNED");
  return provider.operatorId;
}

export async function finalizePolicyActivation({
  context = loadLedgerContext(),
  activationPackage,
  receiptEvidence,
  primaryRpcUrl,
  secondaryRpcUrl,
  observationsPath = context.observationsPath,
  primaryClient = null,
  collectPublication = collectPolicyActivationPublicationSnapshot,
  reconcilePublications = reconcilePolicyActivationPublicationSnapshots,
}) {
  validatePolicyActivationPackage(activationPackage, context.deployment);
  if (
    receiptEvidence?.schema !==
      "agentpool.testnet.v44.policy-activation-receipt/v1" ||
    receiptEvidence.packageSha256 !== activationPackage.packageSha256 ||
    receiptEvidence.requestSha256 !==
      activationPackage.request.requestSha256
  ) {
    throw new Error("V44_POLICY_ACTIVATION_RECEIPT_INVALID");
  }
  if (!primaryRpcUrl || !secondaryRpcUrl) {
    throw new Error("V44_POLICY_ACTIVATION_TWO_RPCS_REQUIRED");
  }
  if (fs.existsSync(observationsPath)) {
    throw new Error("V44_POLICY_ACTIVATION_OBSERVATIONS_ALREADY_EXIST");
  }
  const reader =
    primaryClient ??
    createPublicClient({
      chain: baseSepolia,
      transport: http(primaryRpcUrl, { timeout: 60_000, retryCount: 3 }),
    });
  const receipt = await reader.getTransactionReceipt({
    hash: receiptEvidence.transactionHash,
  });
  if (receipt.status !== "success") {
    throw new Error("V44_POLICY_ACTIVATION_TRANSACTION_REVERTED");
  }
  const anchorAbi = artifact("AgentPoolV44PolicyAnchor").abi;
  let publicationLog = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !==
      context.deployment.contracts.policyAnchor.toLowerCase()
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: anchorAbi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName === "PolicyActivationAnchored") {
        publicationLog = log;
        break;
      }
    } catch {
      // Ignore unrelated logs emitted in the same receipt.
    }
  }
  if (!publicationLog || !Number.isSafeInteger(Number(publicationLog.logIndex))) {
    throw new Error("V44_POLICY_ACTIVATION_EVENT_MISSING");
  }
  const autonomyPolicy = structuredClone(activationPackage.autonomyPolicy);
  autonomyPolicy.policyActivation.anchorHistory[0].publication = {
    transactionHash: receiptEvidence.transactionHash,
    logIndex: Number(publicationLog.logIndex),
  };
  const snapshots = await Promise.all([
    collectPublication({
      rpcUrl: primaryRpcUrl,
      deployment: context.deployment,
      activation: autonomyPolicy.policyActivation,
      providerOperatorId: providerOperator(autonomyPolicy, primaryRpcUrl),
    }),
    collectPublication({
      rpcUrl: secondaryRpcUrl,
      deployment: context.deployment,
      activation: autonomyPolicy.policyActivation,
      providerOperatorId: providerOperator(autonomyPolicy, secondaryRpcUrl),
    }),
  ]);
  const reconciled = reconcilePublications({
    providers: snapshots,
    providerOperatorPolicy: autonomyPolicy.governanceEventProviderPolicy,
  });
  const policyIdentity = autonomyPolicyIdentity(
    autonomyPolicy,
    activationPackage.evidencePipelineCommit,
    {
      policyAnchorAddress:
        context.deployment.contracts.policyAnchor,
      trustedPublications: reconciled.publications,
    },
  );
  const startedAt = policyIdentity.activatedAt;
  const endedAt = new Date(Date.parse(startedAt) + 1).toISOString();
  const ledger = newObservationLedger({
    deployment: context.deployment,
    policyEvidence: context.policyEvidence,
    evidencePipelineCommit: activationPackage.evidencePipelineCommit,
    startedAt,
    endedAt,
    autonomyPolicy,
    resolvedPolicyIdentity: policyIdentity,
  });
  ledger.reliabilityParticipants =
    activationPackage.reliabilityParticipants;
  ledger.autonomyPolicy = autonomyPolicy;
  ledger.policyActivation = autonomyPolicy.policyActivation;
  const resolvedPolicy = {
    ...context.policyEvidence.policy,
    autonomyV2: autonomyPolicy,
  };
  validateObservations(ledger, {
    policy: resolvedPolicy,
    policySha256: context.policyEvidence.policySha256,
    deployment: context.deployment,
    evidencePipelineCommit: activationPackage.evidencePipelineCommit,
    trustedActivationPublications: reconciled.publications,
  });
  writeJsonAtomic(observationsPath, ledger);
  return {
    ok: true,
    campaignId: context.deployment.campaignId,
    transactionHash: receiptEvidence.transactionHash,
    anchorHash: policyIdentity.activationAnchorHash,
    activatedAt: policyIdentity.activatedAt,
    activatedBlock: policyIdentity.activatedBlock,
    providerOperators: snapshots.map((snapshot) => snapshot.providerOperatorId),
    observationsPath,
    reliabilityWindowStarted: true,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const packageValue = argument("package");
  const receiptValue = argument("receipt");
  if (!packageValue || !receiptValue) {
    throw new Error("V44_POLICY_ACTIVATION_INPUTS_MISSING");
  }
  const result = await finalizePolicyActivation({
    activationPackage: readJson(path.resolve(packageValue)),
    receiptEvidence: readJson(path.resolve(receiptValue)),
    primaryRpcUrl: process.env.AGENTPOOL_V44_TESTNET_RPC_URL,
    secondaryRpcUrl: process.env.AGENTPOOL_V44_TESTNET_SECONDARY_RPC_URL,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
