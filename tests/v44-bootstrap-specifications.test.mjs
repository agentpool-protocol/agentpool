import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { keccak256, toBytes } from "viem";
import {
  V44_BOOTSTRAP_DELIVERY_SCHEMA,
  V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA,
  bootstrapDeliveryArtifact,
  bootstrapDeliveryHash,
  bootstrapSpecificationHash,
  validateBootstrapSpecifications,
  verifyPublishedBootstrapSpecifications,
} from "../scripts/lib/v44-bootstrap-specifications.mjs";
import {
  VERSION,
  sha256File,
  sha256TextFileLf,
} from "../scripts/lib/v44-mainnet.mjs";

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentpool-v44-specifications-"),
  );
  const campaignId = "candidate-test-1";
  const sourceCommit = "a".repeat(40);
  const sourceEvidence = {
    sourceCommit,
    values: Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `value${index + 1}`,
        `observed-${index + 1}`,
      ]),
    ),
  };
  const specifications = {
    schema: V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA,
    release: VERSION,
    campaignId,
    sourceCommit,
    canonicalization: "sorted-key-json-v1",
    objectives: [],
  };
  const catalog = {
    schema: "agentpool.mainnet.v44.bootstrap-objectives/v1",
    campaignId,
    mechanicsOnly: false,
    eligibleForReliability: true,
    publicSpecificationsSha256: null,
    objectives: [],
  };
  for (let index = 0; index < 24; index++) {
    const id = `${String(index + 1).padStart(2, "0")}-check`;
    const pointer = `/values/value${index + 1}`;
    const specification = {
      id,
      capability: "reproducible-build-audit",
      description: `check ${index + 1}`,
      sourceEvidencePointer: pointer,
      requiredSourceCommit: sourceCommit,
      deliveryArtifactSchema: V44_BOOTSTRAP_DELIVERY_SCHEMA,
    };
    const delivery = bootstrapDeliveryArtifact({
      campaignId,
      objectiveId: id,
      sourceCommit,
      observed: sourceEvidence.values[`value${index + 1}`],
    });
    specifications.objectives.push(specification);
    catalog.objectives.push({
      objectiveId: id,
      sourceEvidencePointer: pointer,
      capabilityHash: keccak256(toBytes(specification.capability)),
      specificationHash: bootstrapSpecificationHash(specification),
      deliveryHash: bootstrapDeliveryHash(delivery),
      objectiveProofHex: `0x${String(index + 1).padStart(64, "0")}`,
      capacityUnits: 100,
      mechanicsOnly: false,
      eligibleForReliability: true,
      eligibleForWorkPower: false,
    });
  }
  const specificationsPath = path.join(directory, "specifications.json");
  const catalogPath = path.join(directory, "catalog.json");
  fs.writeFileSync(
    specificationsPath,
    `${JSON.stringify(specifications, null, 2)}\n`,
  );
  catalog.publicSpecificationsSha256 = sha256TextFileLf(specificationsPath);
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return {
    directory,
    campaignId,
    sourceCommit,
    sourceEvidence,
    specifications,
    catalog,
    specificationsPath,
    catalogPath,
  };
}

test("real bootstrap specifications bind all public tasks to exact deliveries", () => {
  const value = fixture();
  try {
    const verified = validateBootstrapSpecifications({
      specificationsPath: value.specificationsPath,
      objectiveCatalogPath: value.catalogPath,
      sourceEvidence: value.sourceEvidence,
      campaignId: value.campaignId,
    });
    assert.equal(verified.catalog.objectives.length, 24);
    const deployment = {
      campaignId: value.campaignId,
      sourceCommit: value.sourceCommit,
      bootstrapSpecificationsSha256: verified.specificationsSha256,
      bootstrap: {
        objectives: value.catalog.objectives.map((objective) => ({
          specificationHash: objective.specificationHash,
        })),
      },
    };
    assert.equal(
      verifyPublishedBootstrapSpecifications({
        filePath: value.specificationsPath,
        deployment,
        sourceEvidence: value.sourceEvidence,
      }).fileSha256,
      verified.specificationsSha256,
    );
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a changed source value cannot reuse a committed bootstrap delivery", () => {
  const value = fixture();
  try {
    value.sourceEvidence.values.value1 = "tampered";
    assert.throws(
      () =>
        validateBootstrapSpecifications({
          specificationsPath: value.specificationsPath,
          objectiveCatalogPath: value.catalogPath,
          sourceEvidence: value.sourceEvidence,
          campaignId: value.campaignId,
        }),
      /V44_BOOTSTRAP_DELIVERY_COMMITMENT_INVALID:0/u,
    );
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("bootstrap specification identity is stable across LF and CRLF checkouts", () => {
  const value = fixture();
  try {
    const lfHash = sha256TextFileLf(value.specificationsPath);
    const lfRawHash = sha256File(value.specificationsPath);
    const crlfText = fs
      .readFileSync(value.specificationsPath, "utf8")
      .replaceAll("\n", "\r\n");
    fs.writeFileSync(value.specificationsPath, crlfText);
    assert.equal(sha256TextFileLf(value.specificationsPath), lfHash);
    assert.notEqual(sha256File(value.specificationsPath), lfRawHash);

    const verified = validateBootstrapSpecifications({
      specificationsPath: value.specificationsPath,
      objectiveCatalogPath: value.catalogPath,
      sourceEvidence: value.sourceEvidence,
      campaignId: value.campaignId,
    });
    assert.equal(verified.specificationsSha256, lfHash);
    assert.equal(
      verifyPublishedBootstrapSpecifications({
        filePath: value.specificationsPath,
        deployment: {
          campaignId: value.campaignId,
          sourceCommit: value.sourceCommit,
          bootstrapSpecificationsSha256: lfHash,
          bootstrap: {
            objectives: value.catalog.objectives.map((objective) => ({
              specificationHash: objective.specificationHash,
            })),
          },
        },
        sourceEvidence: value.sourceEvidence,
      }).fileSha256,
      lfHash,
    );
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
