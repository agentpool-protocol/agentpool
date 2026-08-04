import deployment from "@/deployments/84532.v44.mainnet-candidate-6959d3a.json";
import { V44_BUILD_MANIFEST } from "@/lib/v44-build-manifest.generated";

const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function verifiedGitSha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return GIT_SHA.test(normalized) ? normalized : null;
}

function verifiedSha256(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return SHA256.test(normalized) ? normalized : null;
}

export function v44InterfaceProvenance() {
  const interfaceSourceCommit = verifiedGitSha(
    process.env.AGENTPOOL_INTERFACE_SOURCE_COMMIT,
  );
  const siteBuildCommit = verifiedGitSha(
    process.env.AGENTPOOL_SITE_BUILD_COMMIT,
  );
  const sourceTreeArchiveSha256 = verifiedSha256(
    process.env.AGENTPOOL_SOURCE_ARCHIVE_SHA256,
  );
  const siteDeploymentVersion =
    process.env.AGENTPOOL_SITE_DEPLOYMENT_VERSION?.trim() || null;
  const complete =
    V44_BUILD_MANIFEST.schema ===
      "agentpool.v44.interface-build-manifest/v1" &&
    V44_BUILD_MANIFEST.interfaceSourceCommit === interfaceSourceCommit &&
    V44_BUILD_MANIFEST.siteBuildCommit === siteBuildCommit &&
    V44_BUILD_MANIFEST.siteDeploymentVersion === siteDeploymentVersion &&
    V44_BUILD_MANIFEST.sourceTreeArchiveSha256 ===
      sourceTreeArchiveSha256 &&
    V44_BUILD_MANIFEST.generatedFromCleanTree === true &&
    interfaceSourceCommit !== null &&
    siteBuildCommit === interfaceSourceCommit &&
    sourceTreeArchiveSha256 !== null &&
    siteDeploymentVersion !== null;

  return {
    status: complete
      ? "REPRODUCIBLE_BUILD_MANIFEST_VERIFIED"
      : "UNVERIFIED_BUILD_PROVENANCE",
    contractSourceCommit: deployment.sourceCommit,
    interfaceSourceCommit,
    siteBuildCommit,
    siteDeploymentVersion,
    sourceTreeArchiveSha256,
    sourceTreeManifestRoot: V44_BUILD_MANIFEST.sourceTreeManifestRoot,
    sourceFileCount: V44_BUILD_MANIFEST.sourceFileCount,
    buildManifestSha256: V44_BUILD_MANIFEST.buildManifestSha256,
    buildManifestFileSha256:
      V44_BUILD_MANIFEST.buildManifestFileSha256,
    buildManifest: "/agentpool-v44-build-manifest.json",
    canonicalSourceRef: interfaceSourceCommit
      ? `https://github.com/agentpool-protocol/agentpool/tree/${interfaceSourceCommit}`
      : null,
    complete,
  };
}

export function v44ProvenanceHeaders(): Record<string, string> {
  const provenance = v44InterfaceProvenance();
  return {
    "x-agentpool-provenance-status": provenance.status,
    "x-agentpool-interface-commit":
      provenance.interfaceSourceCommit ?? "unverified",
    "x-agentpool-site-deployment-version":
      provenance.siteDeploymentVersion ?? "unverified",
    "x-agentpool-build-manifest-sha256":
      provenance.buildManifestSha256,
    "x-agentpool-build-manifest-file-sha256":
      provenance.buildManifestFileSha256,
    "x-agentpool-source-tree-root":
      provenance.sourceTreeManifestRoot,
  };
}
