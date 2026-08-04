import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TWO_RUNNER_REPORT_SCHEMA =
  "agentpool.v44.two-runner-report/v1";
export const TWO_RUNNER_CAMPAIGN_SCHEMA =
  "agentpool.v44.two-runner-campaign/v1";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${canonicalJson(nested)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function reportBody(report) {
  const body = { ...report };
  delete body.reportSha256;
  return body;
}

export function reportSha256(report) {
  return sha256(canonicalJson(reportBody(report)));
}

function requireString(value, id) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${id}_MISSING`);
  }
  return value.trim();
}

function requireSha256(value, id) {
  const resolved = requireString(value, id).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(resolved)) {
    throw new Error(`${id}_INVALID`);
  }
  return resolved;
}

function requireGitCommit(value, id) {
  const resolved = requireString(value, id).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resolved)) {
    throw new Error(`${id}_INVALID`);
  }
  return resolved;
}

export function validateRunnerReport(report) {
  if (!report || report.schema !== TWO_RUNNER_REPORT_SCHEMA) {
    throw new Error("TWO_RUNNER_REPORT_SCHEMA_INVALID");
  }
  requireString(report.release, "REPORT_RELEASE");
  requireGitCommit(report.sourceCommit, "REPORT_SOURCE_COMMIT");
  const runner = report.runner ?? {};
  requireString(runner.agentId, "REPORT_AGENT_ID");
  requireString(runner.runtimeFamily, "REPORT_RUNTIME_FAMILY");
  requireString(runner.processInstance, "REPORT_PROCESS_INSTANCE");
  requireString(
    runner.operatorControlDomain,
    "REPORT_OPERATOR_CONTROL_DOMAIN",
  );
  requireString(runner.deviceControlDomain, "REPORT_DEVICE_CONTROL_DOMAIN");
  if (runner.independenceClaim !== false) {
    throw new Error("SHARED_RUNNER_CANNOT_CLAIM_INDEPENDENCE");
  }
  if (
    runner.classification !== "SHARED_OPERATOR_ENGINEERING_ONLY"
  ) {
    throw new Error("REPORT_CLASSIFICATION_INVALID");
  }
  const safety = report.safety ?? {};
  for (const key of [
    "mainnetWritesPerformed",
    "realAssetsUsed",
    "economicActivationAttempted",
    "privateKeysExposed",
  ]) {
    if (safety[key] !== false) throw new Error(`REPORT_SAFETY_${key}`);
  }
  if (!Array.isArray(report.checks) || report.checks.length < 4) {
    throw new Error("REPORT_CHECKS_INCOMPLETE");
  }
  const checkIds = new Set();
  for (const check of report.checks) {
    const id = requireString(check?.id, "REPORT_CHECK_ID");
    if (checkIds.has(id)) throw new Error("REPORT_CHECK_ID_DUPLICATE");
    checkIds.add(id);
    if (check.status !== "PASS") throw new Error(`REPORT_CHECK_FAILED:${id}`);
    requireSha256(check.evidenceSha256, `REPORT_CHECK_EVIDENCE:${id}`);
  }
  const expectedHash = reportSha256(report);
  if (requireSha256(report.reportSha256, "REPORT_SHA256") !== expectedHash) {
    throw new Error("REPORT_SHA256_MISMATCH");
  }
  return { ...report, reportSha256: expectedHash };
}

export function validateTwoRunnerCampaign(reports, policy) {
  const stage = policy?.stages?.TWO_RUNNER_TESTNET;
  if (!stage) throw new Error("TWO_RUNNER_POLICY_MISSING");
  const validated = reports.map(validateRunnerReport);
  const sourceCommits = new Set(validated.map((report) => report.sourceCommit));
  const releases = new Set(validated.map((report) => report.release));
  const runtimeFamilies = new Set(
    validated.map((report) => report.runner.runtimeFamily.toLowerCase()),
  );
  const processInstances = new Set(
    validated.map((report) => report.runner.processInstance),
  );
  if (validated.length < stage.minimumRunnerReports) {
    throw new Error("TWO_RUNNER_REPORT_COUNT_INSUFFICIENT");
  }
  if (runtimeFamilies.size < stage.minimumRuntimeFamilies) {
    throw new Error("TWO_RUNNER_RUNTIME_FAMILIES_INSUFFICIENT");
  }
  if (processInstances.size < stage.minimumProcessInstances) {
    throw new Error("TWO_RUNNER_PROCESS_INSTANCES_INSUFFICIENT");
  }
  if (sourceCommits.size !== 1) {
    throw new Error("TWO_RUNNER_SOURCE_COMMIT_MISMATCH");
  }
  if (releases.size !== 1) throw new Error("TWO_RUNNER_RELEASE_MISMATCH");
  const orderedHashes = validated
    .map((report) => report.reportSha256)
    .sort();
  const engineeringEvidenceRoot = sha256(orderedHashes.join(""));
  return {
    schema: TWO_RUNNER_CAMPAIGN_SCHEMA,
    release: validated[0].release,
    sourceCommit: validated[0].sourceCommit,
    eligible: true,
    stage: "TWO_RUNNER_TESTNET",
    reportCount: validated.length,
    runtimeFamilies: [...runtimeFamilies].sort(),
    processInstanceCount: processInstances.size,
    sharedOperatorAllowed: stage.sameOperatorAllowed,
    sharedDeviceAllowed: stage.sameDeviceAllowed,
    countsTowardIndependentOperators: false,
    countsTowardIndependentCustody: false,
    dormantAnchorDeploymentEligible: true,
    economicMainnetDeploymentEligible: false,
    engineeringEvidenceRoot,
    reports: validated.map((report) => ({
      agentId: report.runner.agentId,
      runtimeFamily: report.runner.runtimeFamily,
      reportSha256: report.reportSha256,
    })),
  };
}

export function loadRunnerReports(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
    );
}
