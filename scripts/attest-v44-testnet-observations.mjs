import {
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  observationAttestationMessage,
  verifyObservationAttestations,
} from "./lib/v44-testnet-reliability.mjs";
import {
  loadLedgerContext,
  validateLedger,
  writeJsonAtomic,
} from "./lib/v44-observation-ledger.mjs";
import { readJson, requireEnv } from "./lib/v44-mainnet.mjs";

const context = loadLedgerContext();
const ledger = readJson(context.observationsPath);
validateLedger(ledger, {
  policy: context.policyEvidence.policy,
  policySha256: context.policyEvidence.policySha256,
  deployment: context.deployment,
  evidencePipelineCommit: context.evidencePipelineCommit,
});
const account = privateKeyToAccount(
  requireEnv("V44_TESTNET_OBSERVER_PRIVATE_KEY"),
);
const registeredObserver = context.deployment.bootstrap.validators.find(
  (entry) =>
    getAddress(entry.address).toLowerCase() ===
    account.address.toLowerCase(),
);
if (!registeredObserver) {
  throw new Error("V44_TESTNET_OBSERVER_NOT_REGISTERED");
}
const operatorGroup = registeredObserver.group;
const signature = await account.signMessage({
  message: observationAttestationMessage(ledger),
});
const next = structuredClone(ledger);
next.attestations = next.attestations.filter(
  (entry) =>
    getAddress(entry.observer).toLowerCase() !==
    account.address.toLowerCase(),
);
next.attestations.push({
  observer: account.address,
  operatorGroup,
  signature,
  signedAt: new Date().toISOString(),
});
await verifyObservationAttestations(
  next,
  context.policyEvidence.policy,
  context.deployment,
);
writeJsonAtomic(context.observationsPath, next);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      testnetOnly: true,
      observer: account.address,
      operatorGroup,
      attestationCount: next.attestations.length,
      observationsPath: context.observationsPath,
    },
    null,
    2,
  )}\n`,
);
