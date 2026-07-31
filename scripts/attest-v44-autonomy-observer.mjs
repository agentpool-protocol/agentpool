import fs from "node:fs";
import path from "node:path";
import {
  observerKeyId,
  sha256Json,
  shadowBundleHash,
  signObserverReport,
  validateShadowBundle,
} from "./lib/v44-autonomy-safety.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`V44_OBSERVER_ARGUMENT_MISSING:${name}`);
  return path.resolve(value);
}

const bundlePath = required("bundle");
const reportPath = required("report");
const privateKeyPath = required("private-key");
const publicKeyPath = required("public-key");
const outputPath = path.resolve(argument("output") ?? bundlePath);
const kind = (argument("kind") ?? "ADMISSION").toUpperCase();

const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
const publicKeyPem = fs.readFileSync(publicKeyPath, "utf8");
const signedReport = signObserverReport(
  {
    ...report,
    schema: "agentpool.v44.shadow-report/v1",
    observerPublicKeyPem: publicKeyPem,
    observerKeyId: observerKeyId(publicKeyPem),
  },
  privateKeyPem,
);

bundle.reports = [
  ...(bundle.reports ?? []).filter(
    (entry) => entry.observerKeyId !== signedReport.observerKeyId,
  ),
  signedReport,
];
bundle.reportRoot = sha256Json(bundle.reports);
bundle.bundleHash = shadowBundleHash(bundle);

if (bundle.reports.length >= 2) {
  validateShadowBundle(bundle, { kind });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({
    schema: "agentpool.v44.external-observer-attestation-result/v1",
    status:
      bundle.reports.length >= 2
        ? "INDEPENDENT_QUORUM_VALID"
        : "WAITING_FOR_SECOND_OBSERVER",
    observerKeyId: signedReport.observerKeyId,
    reportHash: signedReport.reportHash,
    reportCount: bundle.reports.length,
    outputPath,
  })}\n`,
);
