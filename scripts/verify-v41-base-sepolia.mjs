import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath =
  process.env.V41_DEPLOYMENT_MANIFEST ??
  path.join(root, "deployments", "84532.v41.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const smokePath = path.join(root, "deployments", "84532.v41.smoke.json");
const smoke = fs.existsSync(smokePath)
  ? JSON.parse(fs.readFileSync(smokePath, "utf8"))
  : null;
if (manifest.chainId !== 84532 || manifest.version !== "4.1.0-alpha") {
  throw new Error("V41_MANIFEST_INVALID");
}
const rpcUrl = process.env.AGENTPOOL_RPC_URL;
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL is required");
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if ((await client.getChainId()) !== 84532) throw new Error("V41_CHAIN_MISMATCH");

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}
async function read(name, address, functionName, args = []) {
  return client.readContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
}
const names = {
  token: "AgentPoolV41Token",
  controller: "AgentPoolV41EmissionController",
  objectiveVerifier: "AgentPoolV41HashVerifier",
  userEscrow: "AgentPoolV41UserEscrow",
  releaseRegistry: "AgentPoolV41ReleaseRegistry",
  artifactRegistry: "AgentPoolV41ArtifactRegistry",
  capabilityVault: "AgentPoolV41EpochVault",
  basicVault: "AgentPoolV41EpochVault",
  validationVault: "AgentPoolV41EpochVault",
};
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
const codeHashes = {};
for (const [key, contractName] of Object.entries(names)) {
  const code = await client.getCode({ address: manifest.contracts[key] });
  check(`bytecode:${key}`, Boolean(code && code !== "0x"), true);
  if (code && code !== "0x") {
    check(`codeSize:${key}`, (code.length - 2) / 2 <= 24_576, true);
    codeHashes[key] = keccak256(code);
  }
  artifact(contractName);
}
check(
  "token.totalSupply",
  await read("AgentPoolV41Token", manifest.contracts.token, "totalSupply"),
  smoke
    ? parseUnits(smoke.totalMintedApool, manifest.token.decimals)
    : 0n,
);
check(
  "token.controller",
  await read(
    "AgentPoolV41Token",
    manifest.contracts.token,
    "emissionController",
  ),
  manifest.contracts.controller,
);
check(
  "controller.verifier",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "objectiveVerifier",
  ),
  manifest.contracts.objectiveVerifier,
);
check(
  "controller.releaseRegistry",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "releaseRegistry",
  ),
  manifest.contracts.releaseRegistry,
);
check(
  "controller.artifactRegistry",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "artifactRegistry",
  ),
  manifest.contracts.artifactRegistry,
);
check(
  "controller.capabilityCapBps",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "CAPABILITY_CAP_BPS",
  ),
  500,
);
check(
  "controller.experimentCapBps",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "EXPERIMENT_CAP_BPS",
  ),
  100,
);
check(
  "controller.issueCapBps",
  await read(
    "AgentPoolV41EmissionController",
    manifest.contracts.controller,
    "ISSUE_CAP_BPS",
  ),
  1000,
);
for (const [index, signer] of manifest.catalogSigners.entries()) {
  check(
    `catalogSigner:${index + 1}`,
    await read(
      "AgentPoolV41EmissionController",
      manifest.contracts.controller,
      "isCatalogSigner",
      [signer],
    ),
    true,
  );
}
for (const key of ["capabilityVault", "basicVault", "validationVault"]) {
  check(
    `authorizedVault:${key}`,
    await read(
      "AgentPoolV41EmissionController",
      manifest.contracts.controller,
      "isVault",
      [manifest.contracts[key]],
    ),
    true,
  );
}
if (smoke) {
  for (const [index, hash] of smoke.transactionHashes.entries()) {
    const receipt = await client.getTransactionReceipt({ hash });
    check(`smoke.transaction:${index + 1}`, receipt.status, "success");
  }
  const assignment = await read(
    "AgentPoolV41EpochVault",
    manifest.contracts.basicVault,
    "assignments",
    [smoke.assignmentId],
  );
  check("smoke.assignmentSettled", Number(assignment[3]), 4);
  const recordedArtifact = await read(
    "AgentPoolV41ArtifactRegistry",
    manifest.contracts.artifactRegistry,
    "artifacts",
    [smoke.artifactId],
  );
  check(
    "smoke.artifactAssignment",
    recordedArtifact[0],
    smoke.assignmentId,
  );
}
const report = {
  ok: checks.every((entry) => entry.passed),
  chainId: 84532,
  manifestPath,
  codeHashes,
  checks,
  verifiedAt: new Date().toISOString(),
};
const reportPath = path.join(root, "outputs", "v41-base-sepolia-verification.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) throw new Error(`V41_VERIFICATION_FAILED:${reportPath}`);
process.stdout.write(
  `${JSON.stringify({ ok: true, checks: checks.length, reportPath })}\n`,
);
