import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  parseEther,
} from "viem";
import { base } from "viem/chains";
import {
  CHAIN_ID,
  CONTRACT_TYPES,
  ROOT,
  VERSION,
  ZERO_ADDRESS,
  artifact,
  loadAndValidateConfig,
  requireEnv,
  sha256File,
  sha256Json,
} from "./lib/v44-mainnet.mjs";

const manifestPath =
  process.env.V44_DEPLOYMENT_MANIFEST ??
  path.join(ROOT, "deployments", "8453.v44.json");
if (!fs.existsSync(manifestPath)) throw new Error("V44_MANIFEST_MISSING");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (
  manifest.schema !== "agentpool.mainnet.v44.deployment/v1" ||
  manifest.chainId !== CHAIN_ID ||
  manifest.network !== "Base" ||
  manifest.version !== VERSION
) {
  throw new Error("V44_MANIFEST_INVALID");
}
const configEvidence = loadAndValidateConfig();
const gatesPath = path.join(ROOT, "mainnet-v44-gates.json");
const rpcUrl = requireEnv("AGENTPOOL_MAINNET_RPC_URL");
const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
const actualChainId = await client.getChainId();
if (actualChainId !== CHAIN_ID) {
  throw new Error(`V44_CHAIN_MISMATCH:${actualChainId}`);
}

async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}

const checks = [];
function check(name, actual, expected) {
  const passed =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: typeof actual === "bigint" ? actual.toString() : actual,
    expected: typeof expected === "bigint" ? expected.toString() : expected,
  });
}

const unsignedManifest = { ...manifest };
delete unsignedManifest.manifestSha256;
check(
  "manifest.selfHash",
  sha256Json(unsignedManifest),
  manifest.manifestSha256,
);
check(
  "manifest.configSha256",
  configEvidence.configSha256,
  manifest.configSha256,
);
check(
  "manifest.gatesSha256",
  sha256File(gatesPath),
  manifest.gatesSha256,
);
check(
  "manifest.financeInvariantHash",
  configEvidence.financeInvariantHash,
  manifest.financeInvariantHash,
);
check("manifest.deployerHasRuntimeAuthority", manifest.deployerHasRuntimeAuthority, false);

const codeHashes = {};
for (const [key, type] of Object.entries(CONTRACT_TYPES)) {
  const address = manifest.contracts?.[key];
  const code = address ? await client.getCode({ address }) : "0x";
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") {
    const bytes = (code.length - 2) / 2;
    check(`codeSize:${key}`, bytes <= 24_576, true);
    codeHashes[key] = keccak256(code);
    check(
      `deployedCodeHash:${key}`,
      codeHashes[key],
      manifest.deployedCodeHashes?.[key],
    );
  }
  artifact(type);
}

for (const [label, name, address, field] of [
  [
    "token",
    "AgentPoolV44Token",
    manifest.contracts.token,
    "configurationAuthority",
  ],
  [
    "escrow",
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
    "configurationAuthority",
  ],
  [
    "coreVault",
    "AgentPoolV43EpochVault",
    manifest.contracts.coreEpochVault,
    "configurationAuthority",
  ],
  [
    "evolutionVault",
    "AgentPoolV43EpochVault",
    manifest.contracts.evolutionEpochVault,
    "configurationAuthority",
  ],
  [
    "ledger",
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "bootstrapAuthority",
  ],
  [
    "registry",
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "configurationAuthority",
  ],
  [
    "capacity",
    "AgentPoolV43CapacityRegistry",
    manifest.contracts.capacityRegistry,
    "configurationAuthority",
  ],
  [
    "proof",
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
    "configurationAuthority",
  ],
  [
    "router",
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "configurationAuthority",
  ],
  [
    "issueGate",
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "configurationAuthority",
  ],
]) {
  check(
    `${label}.temporaryAuthorityRemoved`,
    await read(name, address, field),
    ZERO_ADDRESS,
  );
}

check(
  "token.name",
  await read("AgentPoolV44Token", manifest.contracts.token, "name"),
  "AgentPool",
);
check(
  "token.symbol",
  await read("AgentPoolV44Token", manifest.contracts.token, "symbol"),
  "APOOL",
);
check(
  "token.decimals",
  await read("AgentPoolV44Token", manifest.contracts.token, "decimals"),
  18,
);
check(
  "token.maxSupply",
  await read("AgentPoolV44Token", manifest.contracts.token, "MAX_SUPPLY"),
  parseEther(configEvidence.config.token.maxSupplyApool),
);
check(
  "token.coreMinter",
  await read(
    "AgentPoolV44Token",
    manifest.contracts.token,
    "coreEpochVault",
  ),
  manifest.contracts.coreEpochVault,
);
check(
  "token.evolutionMinter",
  await read(
    "AgentPoolV44Token",
    manifest.contracts.token,
    "evolutionEpochVault",
  ),
  manifest.contracts.evolutionEpochVault,
);

for (const [label, address, lane, weeklyCap, lifetimeCap] of [
  [
    "coreVault",
    manifest.contracts.coreEpochVault,
    keccak256("0x434f5245"),
    configEvidence.config.emission.coreWeeklyCapApool,
    configEvidence.config.emission.coreLifetimeCapApool,
  ],
  [
    "evolutionVault",
    manifest.contracts.evolutionEpochVault,
    keccak256("0x45564f4c5554494f4e"),
    configEvidence.config.emission.evolutionWeeklyCapApool,
    configEvidence.config.emission.evolutionLifetimeCapApool,
  ],
]) {
  check(
    `${label}.token`,
    await read("AgentPoolV43EpochVault", address, "token"),
    manifest.contracts.token,
  );
  check(
    `${label}.lane`,
    await read("AgentPoolV43EpochVault", address, "lane"),
    lane,
  );
  check(
    `${label}.market`,
    await read("AgentPoolV43EpochVault", address, "market"),
    manifest.contracts.taskMarket,
  );
  check(
    `${label}.genesisStart`,
    await read("AgentPoolV43EpochVault", address, "genesisStart"),
    BigInt(manifest.genesisStart),
  );
  check(
    `${label}.weeklyCap`,
    await read("AgentPoolV43EpochVault", address, "weeklyCap"),
    parseEther(weeklyCap),
  );
  check(
    `${label}.lifetimeCap`,
    await read("AgentPoolV43EpochVault", address, "lifetimeCap"),
    parseEther(lifetimeCap),
  );
}

const coreEmitted = await read(
  "AgentPoolV43EpochVault",
  manifest.contracts.coreEpochVault,
  "totalEmitted",
);
const evolutionEmitted = await read(
  "AgentPoolV43EpochVault",
  manifest.contracts.evolutionEpochVault,
  "totalEmitted",
);
const totalSupply = await read(
  "AgentPoolV44Token",
  manifest.contracts.token,
  "totalSupply",
);
check(
  "token.supplyEqualsEpochEmissions",
  totalSupply,
  coreEmitted + evolutionEmitted,
);
check(
  "token.supplyAtOrBelowMax",
  totalSupply <= parseEther(configEvidence.config.token.maxSupplyApool),
  true,
);

for (const [label, name, address] of [
  [
    "escrow",
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
  ],
  [
    "capacity",
    "AgentPoolV43CapacityRegistry",
    manifest.contracts.capacityRegistry,
  ],
  [
    "proof",
    "AgentPoolV432ProofRegistry",
    manifest.contracts.proofRegistry,
  ],
]) {
  check(
    `${label}.market`,
    await read(name, address, "market"),
    manifest.contracts.taskMarket,
  );
}
check(
  "escrow.token",
  await read(
    "AgentPoolV43UserEscrowKernel",
    manifest.contracts.userEscrow,
    "token",
  ),
  manifest.contracts.token,
);
check(
  "registry.consensus",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "registry.recommendedRelease",
  await read(
    "AgentPoolV43ReleaseRegistry",
    manifest.contracts.releaseRegistry,
    "recommendedRelease",
  ),
  manifest.genesisRelease,
);
check(
  "ledger.consensus",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "ledger.activeSettlementRouter",
  await read(
    "AgentPoolV43ContributionLedger",
    manifest.contracts.contributionLedger,
    "isActiveSource",
    [manifest.contracts.settlementRouter],
  ),
  true,
);
check(
  "router.market",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "market",
  ),
  manifest.contracts.taskMarket,
);
check(
  "router.ledger",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "ledger",
  ),
  manifest.contracts.contributionLedger,
);
check(
  "router.consensus",
  await read(
    "AgentPoolV43SettlementRouter",
    manifest.contracts.settlementRouter,
    "consensus",
  ),
  manifest.contracts.evolutionConsensus,
);
check(
  "taskMarket.financeInvariant",
  await read(
    "AgentPoolV432TaskMarket",
    manifest.contracts.taskMarket,
    "financeInvariantHash",
  ),
  manifest.financeInvariantHash,
);
check(
  "issueGate.market",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "market",
  ),
  manifest.contracts.taskMarket,
);
check(
  "issueGate.transitionConsensus",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "transitionConsensus",
  ),
  manifest.contracts.transitionIssueConsensus,
);
check(
  "issueGate.matureConsensus",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "matureConsensus",
  ),
  manifest.contracts.issueConsensus,
);
check(
  "issueGate.bootstrapRoot",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "bootstrapRoot",
  ),
  manifest.bootstrap.issueRoot,
);
check(
  "issueGate.dynamicVerifierCodehash",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "dynamicVerifierCodehash",
  ),
  manifest.bootstrapVerifierCodehash,
);
check(
  "issueGate.dynamicValidatorRoot",
  await read(
    "AgentPoolV435SystemIssueGate",
    manifest.contracts.systemIssueGate,
    "dynamicValidatorRoot",
  ),
  manifest.bootstrap.validatorRoot,
);

for (const [index, hash] of manifest.transactionHashes.entries()) {
  const receipt = await client.getTransactionReceipt({ hash });
  check(`deployment.transaction:${index + 1}`, receipt.status, "success");
  check(
    `deployment.transactionChain:${index + 1}`,
    receipt.chainId ?? CHAIN_ID,
    CHAIN_ID,
  );
}

const report = {
  schema: "agentpool.mainnet.v44.verification/v1",
  ok: checks.every((entry) => entry.passed),
  release: VERSION,
  chainId: CHAIN_ID,
  phase: "BOOTSTRAP",
  manifestPath,
  totalSupply: totalSupply.toString(),
  codeHashes,
  checks,
  verifiedAt: new Date().toISOString(),
};
const reportPath = path.join(ROOT, "outputs", "v44-base-mainnet-verification.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) throw new Error(`V44_VERIFICATION_FAILED:${reportPath}`);
process.stdout.write(
  `${JSON.stringify(
    { ok: true, checks: checks.length, reportPath },
    null,
    2,
  )}\n`,
);
