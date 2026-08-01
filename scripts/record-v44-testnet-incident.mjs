import fs from "node:fs";
import {
  loadLedgerContext,
  requiredArgument,
  validateLedger,
  writeJsonAtomic,
} from "./lib/v44-observation-ledger.mjs";
import { readJson } from "./lib/v44-mainnet.mjs";

const context = loadLedgerContext();
if (!fs.existsSync(context.observationsPath)) {
  throw new Error("V44_TESTNET_OBSERVATIONS_MISSING");
}
const id = requiredArgument("id");
const severity = requiredArgument("severity").toUpperCase();
const status = requiredArgument("status").toUpperCase();
const summary = requiredArgument("summary");
if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) {
  throw new Error("V44_TESTNET_INCIDENT_SEVERITY_INVALID");
}
if (!["OPEN", "RESOLVED"].includes(status)) {
  throw new Error("V44_TESTNET_INCIDENT_STATUS_INVALID");
}
const ledger = readJson(context.observationsPath);
const next = structuredClone(ledger);
const existing = next.incidents.findIndex((entry) => entry.id === id);
const record = {
  id,
  severity,
  status,
  summary,
  updatedAt: new Date().toISOString(),
};
if (existing === -1) next.incidents.push(record);
else next.incidents[existing] = { ...next.incidents[existing], ...record };
next.attestations = [];
validateLedger(next, {
  policy: context.policyEvidence.policy,
  policySha256: context.policyEvidence.policySha256,
  deployment: context.deployment,
  evidencePipelineCommit: context.evidencePipelineCommit,
});
writeJsonAtomic(context.observationsPath, next);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      testnetOnly: true,
      incident: record,
      attestationsReset: true,
      observationsPath: context.observationsPath,
    },
    null,
    2,
  )}\n`,
);
