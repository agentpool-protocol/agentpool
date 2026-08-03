import crypto from "node:crypto";

export const REQUIRED_GOVERNANCE_DRY_RUN_CHECKS = Object.freeze([
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
  "agentpool-v44-governance-dry-run-v2";

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

export function verifyGovernanceDryRunTranscript(
  transcript,
  {
    deploymentManifestSha256,
    maximumFinalizedBlockNumber,
    trustedChecks,
    checkPolicy,
  },
) {
  const checks = transcript?.checks ?? [];
  const policies = checkPolicy ?? [];
  const checkIds = checks.map((check) => check.id);
  const policyIds = policies.map((policy) => policy.id);
  const trustedIds = (trustedChecks ?? []).map((check) => check.id);
  const valid =
    transcript?.schema === "agentpool.v44.governance-dry-run/v2" &&
    transcript.verifierVersion === GOVERNANCE_DRY_RUN_VERIFIER_VERSION &&
    transcript.deploymentManifestSha256 === deploymentManifestSha256 &&
    Number.isSafeInteger(transcript.finalizedBlockNumber) &&
    transcript.finalizedBlockNumber > 0 &&
    transcript.finalizedBlockNumber <= maximumFinalizedBlockNumber &&
    Number.isSafeInteger(transcript.transactionCount) &&
    transcript.transactionCount === checks.length &&
    JSON.stringify(checkIds) ===
      JSON.stringify(REQUIRED_GOVERNANCE_DRY_RUN_CHECKS) &&
    JSON.stringify(policyIds) ===
      JSON.stringify(REQUIRED_GOVERNANCE_DRY_RUN_CHECKS) &&
    JSON.stringify(trustedIds) ===
      JSON.stringify(REQUIRED_GOVERNANCE_DRY_RUN_CHECKS) &&
    checks.every(
      (check) =>
        /^0x[0-9a-f]{64}$/u.test(check.transactionHash ?? "") &&
        Number.isSafeInteger(check.blockNumber) &&
        check.blockNumber > 0 &&
        check.blockNumber <= transcript.finalizedBlockNumber &&
        /^0x[0-9a-f]{64}$/u.test(check.blockHash ?? "") &&
        /^0x[0-9a-f]{64}$/u.test(check.inputHash ?? "") &&
        ["success", "reverted"].includes(check.status) &&
        Array.isArray(check.requiredEvents) &&
        Array.isArray(check.stateReads),
    ) &&
    sha256Json(checks) === sha256Json(trustedChecks) &&
    transcript.result === "PASS";
  return {
    passed: valid,
    verifierVersion: GOVERNANCE_DRY_RUN_VERIFIER_VERSION,
    requiredChecks: [...REQUIRED_GOVERNANCE_DRY_RUN_CHECKS],
    trustedChecksRoot: sha256Json(trustedChecks ?? []),
  };
}
