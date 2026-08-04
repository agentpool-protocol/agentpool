import fs from "node:fs";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { canonicalJson } from "./v44-autonomy-safety.mjs";
import {
  ROOT,
  VERSION,
  readJson,
  requireEnv,
  sha256TextFileLf,
} from "./v44-mainnet.mjs";

export const V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA =
  "agentpool.testnet.v44.bootstrap-specifications/v1";
export const V44_BOOTSTRAP_DELIVERY_SCHEMA =
  "agentpool.testnet.v44.bootstrap-delivery/v1";

function valueAtPointer(value, pointer) {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) {
    throw new Error("V44_BOOTSTRAP_SPECIFICATION_POINTER_INVALID");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => {
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      ) {
        throw new Error("V44_BOOTSTRAP_SPECIFICATION_POINTER_MISSING");
      }
      return current[segment];
    }, value);
}

export function bootstrapDeliveryArtifact({
  campaignId,
  objectiveId,
  sourceCommit,
  observed,
}) {
  return {
    schema: V44_BOOTSTRAP_DELIVERY_SCHEMA,
    campaignId,
    objectiveId,
    sourceCommit,
    observed,
  };
}

export function bootstrapDeliveryHash(artifact) {
  return keccak256(toBytes(canonicalJson(artifact)));
}

export function bootstrapSpecificationHash(specification) {
  return keccak256(toBytes(canonicalJson(specification)));
}

export function validateBootstrapSpecifications({
  specificationsPath,
  objectiveCatalogPath,
  sourceEvidence,
  campaignId,
}) {
  const resolvedSpecificationsPath = path.resolve(
    ROOT,
    specificationsPath,
  );
  const resolvedCatalogPath = path.resolve(ROOT, objectiveCatalogPath);
  if (
    !fs.existsSync(resolvedSpecificationsPath) ||
    !fs.existsSync(resolvedCatalogPath)
  ) {
    throw new Error("V44_BOOTSTRAP_SPECIFICATIONS_FILE_MISSING");
  }
  const specifications = readJson(resolvedSpecificationsPath);
  const catalog = readJson(resolvedCatalogPath);
  const specificationsSha256 = sha256TextFileLf(resolvedSpecificationsPath);
  if (
    specifications.schema !== V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA ||
    specifications.release !== VERSION ||
    specifications.campaignId !== campaignId ||
    specifications.sourceCommit !== sourceEvidence.sourceCommit ||
    specifications.canonicalization !== "sorted-key-json-v1" ||
    !Array.isArray(specifications.objectives) ||
    catalog.schema !== "agentpool.mainnet.v44.bootstrap-objectives/v1" ||
    catalog.campaignId !== campaignId ||
    catalog.mechanicsOnly !== false ||
    catalog.eligibleForReliability !== true ||
    catalog.publicSpecificationsSha256 !== specificationsSha256 ||
    !Array.isArray(catalog.objectives) ||
    catalog.objectives.length !== specifications.objectives.length ||
    catalog.objectives.length < 24 ||
    catalog.objectives.length > 32
  ) {
    throw new Error("V44_BOOTSTRAP_SPECIFICATIONS_IDENTITY_INVALID");
  }
  const objectiveIds = new Set();
  for (let index = 0; index < specifications.objectives.length; index++) {
    const specification = specifications.objectives[index];
    const objective = catalog.objectives[index];
    if (
      typeof specification?.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(specification.id) ||
      objectiveIds.has(specification.id) ||
      specification.sourceEvidencePointer !== objective.sourceEvidencePointer ||
      objective.objectiveId !== specification.id ||
      objective.mechanicsOnly !== false ||
      objective.eligibleForReliability !== true ||
      objective.eligibleForWorkPower !== false ||
      objective.specificationHash !== bootstrapSpecificationHash(specification)
    ) {
      throw new Error(`V44_BOOTSTRAP_SPECIFICATION_INVALID:${index}`);
    }
    objectiveIds.add(specification.id);
    const observed = valueAtPointer(
      sourceEvidence,
      specification.sourceEvidencePointer,
    );
    const artifact = bootstrapDeliveryArtifact({
      campaignId,
      objectiveId: specification.id,
      sourceCommit: sourceEvidence.sourceCommit,
      observed,
    });
    const derivedDeliveryHash = bootstrapDeliveryHash(artifact);
    if (
      objective.deliveryHash !== derivedDeliveryHash ||
      (specification.expectedDeliveryHash !== undefined &&
        specification.expectedDeliveryHash !== derivedDeliveryHash)
    ) {
      throw new Error(`V44_BOOTSTRAP_DELIVERY_COMMITMENT_INVALID:${index}`);
    }
  }
  return {
    specifications,
    catalog,
    specificationsPath: resolvedSpecificationsPath,
    objectiveCatalogPath: resolvedCatalogPath,
    specificationsSha256,
  };
}

export function loadBootstrapSpecificationEvidence({
  env = process.env,
  sourceEvidence,
  objectivesPath,
  objectives,
  catalogId,
  allowMechanicsOnly,
}) {
  const mode = requireEnv("V44_BOOTSTRAP_OBJECTIVE_MODE", env);
  if (mode === "mechanics-only") {
    if (!allowMechanicsOnly) {
      throw new Error("V44_BOOTSTRAP_MECHANICS_ONLY_FORBIDDEN");
    }
    return { mode, reliabilityEligible: false };
  }
  if (mode !== "reliability") {
    throw new Error("V44_BOOTSTRAP_OBJECTIVE_MODE_INVALID");
  }
  const expectedSha256 = requireEnv(
    "V44_BOOTSTRAP_PUBLIC_SPECIFICATIONS_SHA256",
    env,
  ).toLowerCase();
  const evidence = validateBootstrapSpecifications({
    specificationsPath: requireEnv(
      "V44_BOOTSTRAP_PUBLIC_SPECIFICATIONS_FILE",
      env,
    ),
    objectiveCatalogPath: objectivesPath,
    sourceEvidence,
    campaignId: catalogId,
  });
  if (evidence.specificationsSha256 !== expectedSha256) {
    throw new Error("V44_BOOTSTRAP_SPECIFICATIONS_SHA256_MISMATCH");
  }
  if (
    evidence.catalog.objectives.length !== objectives.length ||
    evidence.catalog.objectives.some(
      (objective, index) =>
        objective.capabilityHash.toLowerCase() !==
          objectives[index].capabilityHash.toLowerCase() ||
        objective.specificationHash.toLowerCase() !==
          objectives[index].specificationHash.toLowerCase() ||
        objective.deliveryHash.toLowerCase() !==
          objectives[index].deliveryHash.toLowerCase() ||
        objective.capacityUnits !== objectives[index].capacityUnits,
    )
  ) {
    throw new Error("V44_BOOTSTRAP_SPECIFICATIONS_OBJECTIVES_MISMATCH");
  }
  return {
    mode,
    reliabilityEligible: true,
    ...evidence,
  };
}

export function verifyPublishedBootstrapSpecifications({
  filePath,
  deployment,
  sourceEvidence,
}) {
  const resolvedPath = path.resolve(ROOT, filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error("V44_PUBLISHED_BOOTSTRAP_SPECIFICATIONS_MISSING");
  }
  const specifications = readJson(resolvedPath);
  if (
    specifications.schema !== V44_BOOTSTRAP_SPECIFICATIONS_SCHEMA ||
    specifications.release !== VERSION ||
    specifications.campaignId !== deployment.campaignId ||
    specifications.sourceCommit !== deployment.sourceCommit ||
    specifications.sourceCommit !== sourceEvidence.sourceCommit ||
    specifications.canonicalization !== "sorted-key-json-v1" ||
    sha256TextFileLf(resolvedPath) !==
      deployment.bootstrapSpecificationsSha256 ||
    !Array.isArray(specifications.objectives) ||
    specifications.objectives.length !== deployment.bootstrap.objectives.length
  ) {
    throw new Error("V44_PUBLISHED_BOOTSTRAP_SPECIFICATIONS_INVALID");
  }
  const ids = new Set();
  for (let index = 0; index < specifications.objectives.length; index++) {
    const specification = specifications.objectives[index];
    if (
      ![
        [
          "capability",
          "deliveryArtifactSchema",
          "description",
          "id",
          "requiredSourceCommit",
          "sourceEvidencePointer",
        ],
        [
          "capability",
          "deliveryArtifactSchema",
          "description",
          "expectedDeliveryHash",
          "id",
          "requiredSourceCommit",
          "sourceEvidencePointer",
        ],
      ]
        .map((keys) => keys.sort().join(","))
        .includes(Object.keys(specification).sort().join(",")) ||
      ids.has(specification.id) ||
      specification.requiredSourceCommit !== deployment.sourceCommit ||
      specification.deliveryArtifactSchema !== V44_BOOTSTRAP_DELIVERY_SCHEMA ||
      bootstrapSpecificationHash(specification) !==
        deployment.bootstrap.objectives[index].specificationHash
    ) {
      throw new Error(`V44_PUBLISHED_BOOTSTRAP_SPECIFICATION_INVALID:${index}`);
    }
    const observed = valueAtPointer(
      sourceEvidence,
      specification.sourceEvidencePointer,
    );
    const derivedDeliveryHash = bootstrapDeliveryHash(
      bootstrapDeliveryArtifact({
        campaignId: deployment.campaignId,
        objectiveId: specification.id,
        sourceCommit: deployment.sourceCommit,
        observed,
      }),
    );
    if (
      specification.expectedDeliveryHash !== undefined &&
      specification.expectedDeliveryHash !== derivedDeliveryHash
    ) {
      throw new Error(
        `V44_PUBLISHED_BOOTSTRAP_DELIVERY_HASH_INVALID:${index}`,
      );
    }
    ids.add(specification.id);
  }
  return {
    specifications,
    filePath: resolvedPath,
    fileSha256: sha256TextFileLf(resolvedPath),
  };
}
