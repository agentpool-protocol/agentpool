const REQUIRED_CHECKS = Object.freeze([
  "proposal-bond-funded",
  "issue-proposed",
  "commit-reveal-completed",
  "issue-finalized",
  "recovery-job-created",
  "recovery-refund-completed",
  "exposure-cap-preserved",
  "duplicate-settlement-rejected",
  "fund-conservation-preserved",
]);

export const GOVERNANCE_DRY_RUN_VERIFIER_VERSION =
  "agentpool-v44-governance-dry-run-v1";

export function verifyGovernanceDryRunTranscript(
  transcript,
  { deploymentManifestSha256, finalizedBlockNumber },
) {
  const checks = new Map(
    (transcript?.checks ?? []).map((check) => [check.id, check]),
  );
  const valid =
    transcript?.schema === "agentpool.v44.governance-dry-run/v1" &&
    transcript.verifierVersion === GOVERNANCE_DRY_RUN_VERIFIER_VERSION &&
    transcript.deploymentManifestSha256 === deploymentManifestSha256 &&
    transcript.finalizedBlockNumber === finalizedBlockNumber &&
    Number.isSafeInteger(transcript.transactionCount) &&
    transcript.transactionCount > 0 &&
    REQUIRED_CHECKS.every(
      (id) =>
        checks.get(id)?.passed === true &&
        typeof checks.get(id)?.evidence === "string" &&
        checks.get(id).evidence.length > 0,
    ) &&
    transcript.result === "PASS";
  return {
    passed: valid,
    verifierVersion: GOVERNANCE_DRY_RUN_VERIFIER_VERSION,
    requiredChecks: [...REQUIRED_CHECKS],
  };
}
