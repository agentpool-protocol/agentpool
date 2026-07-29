import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  CHAIN_ID,
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  artifact,
  artifactBytecodeEvidence,
  assertTrackedTreeClean,
  collectReleaseInputs,
  loadAndValidateConfig,
  loadAndValidateGates,
  requireEnv,
} from "./lib/v44-mainnet.mjs";

const manifestPath = path.join(ROOT, "deployments", "8453.v44.json");
const partialPath = path.join(ROOT, "deployments", "8453.v44.partial.json");
if (fs.existsSync(manifestPath)) throw new Error("V44_ALREADY_DEPLOYED");
if (fs.existsSync(partialPath)) {
  throw new Error("V44_PARTIAL_DEPLOYMENT_EXISTS_REVIEW_BEFORE_PREFLIGHT");
}

assertTrackedTreeClean();
const configEvidence = loadAndValidateConfig();
const gateEvidence = loadAndValidateGates();
const sourceCommit = requireEnv("V44_SOURCE_COMMIT").toLowerCase();
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
const releaseInputs = collectReleaseInputs({
  deployerAddress: account.address,
});

const rpcUrl = requireEnv("AGENTPOOL_MAINNET_RPC_URL");
const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 2 }),
});
const actualChainId = await client.getChainId();
if (actualChainId !== CHAIN_ID) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V44_DEPLOYER_BALANCE_WEI ?? "10000000000000000",
);
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
  network: "Base",
  chainId: CHAIN_ID,
  sourceCommit,
  deployer: account.address,
  deployerBalanceEth: formatEther(balance),
  minimumBalanceEth: formatEther(minimumBalance),
  genesisStart: releaseInputs.genesisStart,
  genesisRelease: releaseInputs.genesisRelease,
  bootstrapProposer: releaseInputs.bootstrap.proposer,
  validators: releaseInputs.bootstrap.validators.map((entry) => ({
    address: entry.address,
    groupId: entry.group,
  })),
  configSha256: configEvidence.configSha256,
  gatesSha256: gateEvidence.gatesSha256,
  approvedGateEvidence: gateEvidence.approved,
  financeInvariantHash: configEvidence.financeInvariantHash,
  artifacts: bytecode,
  artifactSetHash: keccak256(
    `0x${Buffer.from(JSON.stringify(bytecode)).toString("hex")}`,
  ),
  manifestPath,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
