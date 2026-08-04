import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import {
  V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA,
  bootstrapDeliveryArtifact,
  bootstrapDeliveryHash,
  bootstrapSpecificationHash,
  validateBootstrapSpecifications,
} from "./lib/v44-bootstrap-specifications.mjs";
import {
  ROOT,
  VERSION,
  assertTrackedTreeClean,
  currentGitCommit,
  sha256File,
} from "./lib/v44-mainnet.mjs";
import { verifyV44ReleaseEvidenceFile } from "./generate-v44-release-evidence.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}

function evidencePointer(pointer, description) {
  return { pointer, description };
}

function verificationTargets(sourceEvidence) {
  const globals = [
    evidencePointer("/sourceCommit", "exact deployment source commit"),
    evidencePointer("/sourceTree", "exact deployment source tree"),
    evidencePointer("/packageLockSha256", "locked dependency graph digest"),
    evidencePointer("/configSha256", "economic configuration digest"),
    evidencePointer("/financeInvariantHash", "finance invariant commitment"),
    evidencePointer("/solcVersion", "Solidity compiler identity"),
    evidencePointer("/compilerSettings", "Solidity compiler settings"),
  ];
  const artifacts = Object.keys(sourceEvidence.artifacts ?? {})
    .sort()
    .map((type) =>
      evidencePointer(
        `/artifacts/${type}`,
        `${type} creation and runtime bytecode evidence`,
      ),
    );
  const targets = [...globals, ...artifacts];
  if (targets.length !== 24) {
    throw new Error(`V44_BOOTSTRAP_TARGET_COUNT_INVALID:${targets.length}`);
  }
  return targets;
}

function objectiveId(pointer, index) {
  const suffix = pointer
    .split("/")
    .filter(Boolean)
    .at(-1)
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
  return `${String(index + 1).padStart(2, "0")}-${suffix}`;
}

export function generateBootstrapVerificationObjectives({
  campaignId,
  sourceEvidencePath,
  privateCatalogPath,
  publicSpecificationsPath,
  replace = false,
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(campaignId ?? "")) {
    throw new Error("V44_TESTNET_CAMPAIGN_ID_INVALID");
  }
  const resolvedSourceEvidencePath = path.resolve(ROOT, sourceEvidencePath);
  const resolvedCatalogPath = path.resolve(ROOT, privateCatalogPath);
  const resolvedSpecificationsPath = path.resolve(
    ROOT,
    publicSpecificationsPath,
  );
  for (const outputPath of [resolvedCatalogPath, resolvedSpecificationsPath]) {
    if (fs.existsSync(outputPath) && !replace) {
      throw new Error(`V44_BOOTSTRAP_OBJECTIVE_OUTPUT_EXISTS:${outputPath}`);
    }
  }
  assertTrackedTreeClean();
  const sourceEvidence = verifyV44ReleaseEvidenceFile(
    resolvedSourceEvidencePath,
  ).evidence;
  if (
    sourceEvidence.schema !==
      "agentpool.mainnet.v44.source-reproducibility/v1" ||
    sourceEvidence.release !== VERSION ||
    sourceEvidence.sourceCommit !== currentGitCommit().toLowerCase()
  ) {
    throw new Error("V44_BOOTSTRAP_SOURCE_EVIDENCE_INVALID");
  }
  const specifications = {
    schema: V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA,
    release: VERSION,
    campaignId,
    sourceCommit: sourceEvidence.sourceCommit,
    canonicalization: "sorted-key-json-v1",
    reproduction: [
      "npm ci",
      "npm run contracts:compile",
      "npm run evidence:v4.4:source",
    ],
    artifactRule:
      "Read sourceEvidencePointer from the freshly reproduced source evidence and encode the documented delivery artifact using recursively sorted JSON keys with no trailing newline.",
    objectives: [],
  };
  const catalog = {
    schema: "agentpool.mainnet.v44.bootstrap-objectives/v1",
    purpose:
      "Exact-source AgentPool build and bytecode verification objectives for the public Base Sepolia candidate campaign.",
    campaignId,
    mechanicsOnly: false,
    eligibleForReliability: true,
    eligibleForWorkPower: false,
    publicSpecificationsSha256: null,
    objectives: [],
  };
  for (const [index, target] of verificationTargets(sourceEvidence).entries()) {
    const id = objectiveId(target.pointer, index);
    const specification = {
      id,
      capability: target.pointer.startsWith("/artifacts/")
        ? "evm-bytecode-reproduction"
        : "reproducible-build-audit",
      description: target.description,
      sourceEvidencePointer: target.pointer,
      requiredSourceCommit: sourceEvidence.sourceCommit,
      deliveryArtifactSchema:
        "agentpool.testnet.v44.bootstrap-delivery/v1",
    };
    const observed = target.pointer
      .slice(1)
      .split("/")
      .reduce((current, segment) => current[segment], sourceEvidence);
    const artifact = bootstrapDeliveryArtifact({
      campaignId,
      objectiveId: id,
      sourceCommit: sourceEvidence.sourceCommit,
      observed,
    });
    specifications.objectives.push(specification);
    catalog.objectives.push({
      objectiveId: id,
      sourceEvidencePointer: target.pointer,
      capabilityHash: keccak256(toBytes(specification.capability)),
      specificationHash: bootstrapSpecificationHash(specification),
      deliveryHash: bootstrapDeliveryHash(artifact),
      objectiveProofHex: `0x${crypto.randomBytes(48).toString("hex")}`,
      capacityUnits: 100,
      mechanicsOnly: false,
      eligibleForReliability: true,
      eligibleForWorkPower: false,
    });
  }
  fs.mkdirSync(path.dirname(resolvedSpecificationsPath), { recursive: true });
  fs.writeFileSync(
    resolvedSpecificationsPath,
    `${JSON.stringify(specifications, null, 2)}\n`,
    "utf8",
  );
  catalog.publicSpecificationsSha256 = sha256File(
    resolvedSpecificationsPath,
  );
  fs.mkdirSync(path.dirname(resolvedCatalogPath), { recursive: true });
  fs.writeFileSync(
    resolvedCatalogPath,
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
  validateBootstrapSpecifications({
    specificationsPath: resolvedSpecificationsPath,
    objectiveCatalogPath: resolvedCatalogPath,
    sourceEvidence,
    campaignId,
  });
  return {
    campaignId,
    sourceCommit: sourceEvidence.sourceCommit,
    objectiveCount: catalog.objectives.length,
    privateCatalogPath: resolvedCatalogPath,
    publicSpecificationsPath: resolvedSpecificationsPath,
    publicSpecificationsSha256: catalog.publicSpecificationsSha256,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const campaignId =
    argument("campaign") ?? process.env.V44_TESTNET_CAMPAIGN_ID?.trim();
  const result = generateBootstrapVerificationObjectives({
    campaignId,
    sourceEvidencePath:
      argument("source-evidence") ??
      "outputs/v44-source-reproducibility.json",
    privateCatalogPath:
      argument("private-output") ??
      `.testnet-v44-real-objectives.${campaignId}.local.json`,
    publicSpecificationsPath:
      argument("public-output") ??
      `outputs/v44-bootstrap-specifications.${campaignId}.json`,
    replace: process.argv.includes("--replace"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}
