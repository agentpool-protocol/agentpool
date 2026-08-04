import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireHex(value, length, id) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) {
    throw new Error(`${id}_INVALID`);
  }
  return value;
}

export function assertDormantAnchorArtifact(artifact) {
  if (artifact?.contractName !== "AgentPoolV44DormantDeploymentAnchor") {
    throw new Error("DORMANT_ANCHOR_ARTIFACT_INVALID");
  }
  const functions = artifact.abi.filter((entry) => entry.type === "function");
  if (
    functions.length === 0 ||
    functions.some((entry) => entry.stateMutability !== "view")
  ) {
    throw new Error("DORMANT_ANCHOR_HAS_ECONOMIC_OR_MUTABLE_SURFACE");
  }
  if (!/^0x[0-9a-f]+$/iu.test(artifact.bytecode ?? "0x")) {
    throw new Error("DORMANT_ANCHOR_BYTECODE_MISSING");
  }
  return true;
}

export function buildDormantAnchorIntent({
  campaign,
  policy,
  artifact,
  candidateSourceCommit,
  gitTreeId,
  releaseConfigBytes,
  stagingPolicyBytes,
}) {
  const stage = policy?.stages?.DORMANT_MAINNET;
  if (
    !stage ||
    stage.allowedContracts.length !== 1 ||
    stage.allowedContracts[0] !== "AgentPoolV44DormantDeploymentAnchor" ||
    stage.tokenDeploymentAllowed !== false ||
    stage.emissionAllowed !== false ||
    stage.rewardAllowed !== false ||
    stage.userDepositsAllowed !== false ||
    stage.taskSettlementAllowed !== false ||
    stage.activationTransactionExists !== false ||
    stage.requiresSeparateMatureDeployment !== true
  ) {
    throw new Error("DORMANT_STAGE_POLICY_UNSAFE");
  }
  if (
    campaign?.eligible !== true ||
    campaign.stage !== "TWO_RUNNER_TESTNET" ||
    campaign.dormantAnchorDeploymentEligible !== true ||
    campaign.economicMainnetDeploymentEligible !== false ||
    campaign.countsTowardIndependentOperators !== false ||
    campaign.countsTowardIndependentCustody !== false
  ) {
    throw new Error("TWO_RUNNER_CAMPAIGN_NOT_ELIGIBLE");
  }
  assertDormantAnchorArtifact(artifact);
  const resolvedSourceCommit = requireHex(
    candidateSourceCommit,
    candidateSourceCommit?.length === 64 ? 64 : 40,
    "CANDIDATE_SOURCE_COMMIT",
  );
  if (campaign.sourceCommit !== resolvedSourceCommit) {
    throw new Error("CAMPAIGN_SOURCE_COMMIT_MISMATCH");
  }
  requireHex(gitTreeId, 40, "GIT_TREE_ID");
  const evidenceRoot = requireHex(
    campaign.engineeringEvidenceRoot,
    64,
    "ENGINEERING_EVIDENCE_ROOT",
  );
  const sourceTreeHash = sha256(gitTreeId);
  const releaseConfigHash = sha256(releaseConfigBytes);
  const stagingPolicyHash = sha256(stagingPolicyBytes);
  return {
    schema: "agentpool.v44.dormant-mainnet-anchor-intent/v1",
    targetChainId: 8453,
    contract: "AgentPoolV44DormantDeploymentAnchor",
    candidateSourceCommit: resolvedSourceCommit,
    economicSystemDeployed: false,
    tokenDeployed: false,
    emissionEnabled: false,
    rewardsEnabled: false,
    userDepositsEnabled: false,
    settlementEnabled: false,
    laterActivationPossible: false,
    requiresSeparateMatureDeployment: true,
    constructorArgs: [
      `0x${sourceTreeHash}`,
      `0x${releaseConfigHash}`,
      `0x${stagingPolicyHash}`,
      `0x${evidenceRoot}`,
    ],
    bytecodeSha256: sha256(Buffer.from(artifact.bytecode.slice(2), "hex")),
  };
}
