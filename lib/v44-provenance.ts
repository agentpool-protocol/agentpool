import deployment from "@/deployments/84532.v44.json";

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
    interfaceSourceCommit !== null &&
    siteBuildCommit === interfaceSourceCommit &&
    sourceTreeArchiveSha256 !== null &&
    siteDeploymentVersion !== null;

  return {
    status: complete ? "VERIFIED_BUILD_PROVENANCE" : "UNVERIFIED_BUILD_PROVENANCE",
    contractSourceCommit: deployment.sourceCommit,
    interfaceSourceCommit,
    siteBuildCommit,
    siteDeploymentVersion,
    sourceTreeArchiveSha256,
    canonicalSourceRef: interfaceSourceCommit
      ? `https://github.com/agentpool-protocol/agentpool/tree/${interfaceSourceCommit}`
      : null,
    complete,
  };
}
