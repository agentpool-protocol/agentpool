import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  artifact,
  artifactBytecodeEvidence,
  assertTrackedTreeClean,
  bootstrapIdentitySha256,
  collectReleaseInputs,
  loadAndValidateConfig,
  loadAndValidateGates,
  requireEnv,
  requireThresholdAuthorityConfig,
} from "./lib/v44-mainnet.mjs";
import {
  requireProfileEnvironment,
  resolveV44ChainProfile,
} from "./lib/v44-chain-profile.mjs";
import { verifyV44ReleaseEvidenceFile } from "./generate-v44-release-evidence.mjs";
import {
  verifyPublicTestnetReliabilityGate,
} from "./lib/v44-testnet-reliability.mjs";

const profile = resolveV44ChainProfile({
  ...process.env,
  V44_DEPLOYMENT_PROFILE: process.argv.includes("--testnet")
    ? "testnet"
    : "mainnet",
});
const { manifestPath, partialPath } = profile;
if (fs.existsSync(manifestPath)) throw new Error("V44_ALREADY_DEPLOYED");
if (fs.existsSync(partialPath)) {
  throw new Error("V44_PARTIAL_DEPLOYMENT_EXISTS_REVIEW_BEFORE_PREFLIGHT");
}

assertTrackedTreeClean();
const configEvidence = loadAndValidateConfig();
const gateEvidence = profile.requireReleaseGates
  ? loadAndValidateGates()
  : null;
if (gateEvidence) {
  await verifyPublicTestnetReliabilityGate({ gateEvidence });
}
const sourceEvidencePath = profile.requireReleaseGates
  ? gateEvidence.evidencePaths.finalSourceReproducibility
  : path.resolve(
      ROOT,
      requireEnv("V44_SOURCE_EVIDENCE_FILE"),
    );
const sourceEvidence = verifyV44ReleaseEvidenceFile(
  sourceEvidencePath,
);
const sourceCommit = requireEnv("V44_SOURCE_COMMIT").toLowerCase();
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const thresholdAuthority = requireThresholdAuthorityConfig();
const releaseInputs = collectReleaseInputs({
  deployerAddress: account.address,
});

const { rpcUrl, minimumBalance } = requireProfileEnvironment(profile);
const client = createPublicClient({
  chain: profile.chain,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 2 }),
});
const actualChainId = await client.getChainId();
if (actualChainId !== profile.chainId) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}
const balance = await client.getBalance({ address: account.address });
if (balance < minimumBalance) {
  throw new Error(
    `V44_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
  );
}
const bytecode = artifactBytecodeEvidence();
for (const [key, name] of Object.entries(CONTRACT_TYPES)) {
  const compiled = artifact(name);
  const runtimeBytes = (compiled.deployedBytecode.length - 2) / 2;
  if (runtimeBytes <= 0 || runtimeBytes > 24_576) {
    throw new Error(`V44_CODE_SIZE_INVALID:${key}:${runtimeBytes}`);
  }
}

const report = {
  ok: true,
  release: VERSION,
  deploymentProfile: profile.id,
  testnetOnly: profile.testnetOnly,
  network: profile.network,
  chainId: profile.chainId,
  sourceCommit,
  deployer: account.address,
  thresholdAuthorityOwners: thresholdAuthority.owners,
  thresholdAuthorityThreshold: thresholdAuthority.threshold,
  deployerBalanceEth: formatEther(balance),
  minimumBalanceEth: formatEther(minimumBalance),
  genesisStart: releaseInputs.genesisStart,
  genesisRelease: releaseInputs.genesisRelease,
  bootstrapProposer: releaseInputs.bootstrap.proposer,
  bootstrapObjectives: releaseInputs.bootstrap.objectives.length,
  bootstrapObjectivesSha256: releaseInputs.bootstrap.objectivesSha256,
  bootstrapIdentitySha256: bootstrapIdentitySha256(releaseInputs),
  validators: releaseInputs.bootstrap.validators.map((entry) => ({
    address: entry.address,
    groupId: entry.group,
  })),
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence?.gatesSha256 ?? null,
  approvedGateEvidence: gateEvidence?.approved ?? null,
  sourceEvidenceFileSha256: sourceEvidence.fileSha256,
  sourceEvidenceBodySha256: sourceEvidence.evidence.evidenceSha256,
  financeInvariantHash: configEvidence.financeInvariantHash,
  artifacts: bytecode,
  artifactSetHash: keccak256(
    `0x${Buffer.from(JSON.stringify(bytecode)).toString("hex")}`,
  ),
  manifestPath,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
