import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const manifestPath = path.join(root, "deployments", "84532.v41.json");
const smokePath = path.join(root, "deployments", "84532.v41.smoke.json");
if (fs.existsSync(smokePath)) {
  throw new Error("V41_SMOKE_ALREADY_COMPLETED");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 84532 || manifest.network !== "Base Sepolia") {
  throw new Error("V41_SMOKE_CHAIN_MISMATCH");
}
if (requireEnv("V41_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("V41_SMOKE_REQUIRES_DISPOSABLE_PROFILE");
}

const deployer = privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"));
if (deployer.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("V41_SMOKE_DEPLOYER_MISMATCH");
}
const catalog = Array.from({ length: 5 }, (_, index) => {
  const account = privateKeyToAccount(
    requireEnv(`V41_CATALOG_SIGNER_PRIVATE_KEY_${index + 1}`),
  );
  const expected = getAddress(manifest.catalogSigners[index]);
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("V41_SMOKE_CATALOG_KEY_MISMATCH");
  }
  return account;
});

const transport = http(requireEnv("AGENTPOOL_RPC_URL"));
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport,
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("V41_SMOKE_CHAIN_MISMATCH");
}

const vault = manifest.contracts.basicVault;
const token = manifest.contracts.token;
const artifactRegistry = manifest.contracts.artifactRegistry;
const vaultAbi = artifact("AgentPoolV41EpochVault").abi;
const tokenAbi = artifact("AgentPoolV41Token").abi;
const artifactAbi = artifact("AgentPoolV41ArtifactRegistry").abi;
const block = await publicClient.getBlock();
const assignmentId = keccak256(
  toBytes("agentpool-v41-base-sepolia-basic-smoke-v1"),
);
const specificationHash = keccak256(
  toBytes("normalize deterministic MCP fixture smoke v1"),
);
const deliveryHash = keccak256(
  toBytes("agentpool-v41-smoke-artifact-content-v1"),
);
const proof = toHex("deterministic smoke verifier passed");
const expectedEvidenceHash = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [specificationHash, deliveryHash, keccak256(proof)],
  ),
);
const artifactId = keccak256(toBytes("agentpool-v41-smoke-artifact-v1"));
const provenanceHash = keccak256(
  toBytes("agentpool-v41-smoke-provenance-v1"),
);
const licenseHash = keccak256(toBytes("MIT"));
const zeroHash = `0x${"0".repeat(64)}`;
const recipients = [
  deployer.address,
  catalog[0].address,
  catalog[1].address,
  catalog[2].address,
];
const amounts = [
  parseUnits("70", manifest.token.decimals),
  parseUnits("10", manifest.token.decimals),
  parseUnits("10", manifest.token.decimals),
  parseUnits("10", manifest.token.decimals),
];
const reservedPayout = amounts.reduce((sum, amount) => sum + amount, 0n);
const payoutRoot = keccak256(
  encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }],
    [recipients, amounts],
  ),
);
const deadline = Number(block.timestamp + 3_600n);
const task = {
  assignmentId,
  worker: deployer.address,
  reservedPayout,
  deadline,
  specificationHash,
  expectedEvidenceHash,
  payoutRoot,
  artifactId,
  provenanceHash,
  licenseHash,
  moduleId: zeroHash,
};
const domain = {
  name: "AgentPool v4.1 EpochVault",
  version: "1",
  chainId: 84532,
  verifyingContract: vault,
};
const types = {
  TaskAdmission: [
    { name: "assignmentId", type: "bytes32" },
    { name: "worker", type: "address" },
    { name: "reservedPayout", type: "uint128" },
    { name: "deadline", type: "uint64" },
    { name: "specificationHash", type: "bytes32" },
    { name: "expectedEvidenceHash", type: "bytes32" },
    { name: "payoutRoot", type: "bytes32" },
    { name: "artifactId", type: "bytes32" },
    { name: "provenanceHash", type: "bytes32" },
    { name: "licenseHash", type: "bytes32" },
    { name: "moduleId", type: "bytes32" },
  ],
};
const signatures = await Promise.all(
  catalog.slice(0, manifest.catalogQuorum).map((account) =>
    account.signTypedData({
      domain,
      types,
      primaryType: "TaskAdmission",
      message: task,
    }),
  ),
);

const transactionHashes = [];
async function write(functionName, args) {
  const hash = await walletClient.writeContract({
    account: deployer,
    address: vault,
    abi: vaultAbi,
    functionName,
    args,
  });
  transactionHashes.push(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`V41_SMOKE_${functionName.toUpperCase()}_FAILED:${hash}`);
  }
  return receipt;
}

async function assignmentState() {
  const assignment = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "assignments",
    args: [assignmentId],
  });
  return Number(assignment[3]);
}
async function waitForState(expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await assignmentState()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`V41_SMOKE_STATE_NOT_VISIBLE:${expected}`);
}

let state = await assignmentState();
if (state === 0) {
  await write("openAssignment", [
    assignmentId,
    deployer.address,
    reservedPayout,
    deadline,
    specificationHash,
    expectedEvidenceHash,
    payoutRoot,
    artifactId,
    provenanceHash,
    licenseHash,
    zeroHash,
    signatures,
  ]);
  await waitForState(1);
  state = 1;
}
if (state === 1) {
  await write("accept", [assignmentId]);
  await waitForState(2);
  state = 2;
}
if (state === 2) {
  await write("deliver", [assignmentId, deliveryHash]);
  await waitForState(3);
  state = 3;
}
if (state === 3) {
  await write("settle", [
    assignmentId,
    proof,
    recipients,
    amounts,
    deliveryHash,
  ]);
  await waitForState(4);
  state = 4;
}
if (state !== 4) {
  throw new Error(`V41_SMOKE_UNRECOVERABLE_STATE:${state}`);
}

const [supplyAfter, assignment, recordedArtifact, balances] = await Promise.all([
  publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "totalSupply",
  }),
  publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "assignments",
    args: [assignmentId],
  }),
  publicClient.readContract({
    address: artifactRegistry,
    abi: artifactAbi,
    functionName: "artifacts",
    args: [artifactId],
  }),
  Promise.all(
    recipients.map((address) =>
      publicClient.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    ),
  ),
]);

const checks = {
  supplyEqualsCommittedSmokePayout: supplyAfter === reservedPayout,
  assignmentSettled: Number(assignment[3]) === 4,
  artifactRecorded:
    recordedArtifact[0].toLowerCase() === assignmentId.toLowerCase() &&
    recordedArtifact[1].toLowerCase() === deliveryHash.toLowerCase() &&
    Number(recordedArtifact[5]) > 0,
  exactRecipientBalances: balances.every(
    (balance, index) => balance === amounts[index],
  ),
  duplicateSettlementRejected: false,
};
try {
  await publicClient.simulateContract({
    account: deployer,
    address: vault,
    abi: vaultAbi,
    functionName: "settle",
    args: [assignmentId, proof, recipients, amounts, deliveryHash],
  });
} catch {
  checks.duplicateSettlementRejected = true;
}
if (!Object.values(checks).every(Boolean)) {
  throw new Error(`V41_SMOKE_CHECK_FAILED:${JSON.stringify(checks)}`);
}

const deploymentReceipt = await publicClient.getTransactionReceipt({
  hash: manifest.transactionHashes[0],
});
const eventTransactions = Array.from(
  new Set(
    (
      await publicClient.getContractEvents({
        address: vault,
        abi: vaultAbi,
        fromBlock: deploymentReceipt.blockNumber,
        toBlock: "latest",
        strict: true,
      })
    )
      .filter(
        (event) =>
          "assignmentId" in event.args &&
          event.args.assignmentId?.toLowerCase() === assignmentId.toLowerCase(),
      )
      .map((event) => event.transactionHash),
  ),
);

const output = {
  ok: true,
  network: "Base Sepolia",
  chainId: 84532,
  assignmentId,
  artifactId,
  vault,
  token,
  recipients,
  payoutApool: ["70", "10", "10", "10"],
  totalMintedApool: "100",
  transactionHashes: eventTransactions,
  checks,
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(smokePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(output)}\n`);
