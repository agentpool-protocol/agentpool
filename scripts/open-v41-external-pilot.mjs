import crypto from "node:crypto";
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
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v41.json"), "utf8"),
);
const pilot = JSON.parse(
  fs.readFileSync(
    path.join(root, "protocol", "v41-external-pilot.json"),
    "utf8",
  ),
);
const vaultAbi = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV41EpochVault.json"),
    "utf8",
  ),
).abi;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function v41Hash(value) {
  return keccak256(toBytes(stableJson(value)));
}

async function json(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${response.status} ${payload?.error?.code ?? "REQUEST_FAILED"}: ${
        payload?.error?.message ?? JSON.stringify(payload)
      }`,
    );
  }
  return payload;
}

async function signedWrite(account, baseUrl, route, body) {
  const bodyText = JSON.stringify(body);
  const nonce = await json(`${baseUrl}/api/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const bodyHash = `0x${crypto
    .createHash("sha256")
    .update(bodyText)
    .digest("hex")}`;
  const message = [
    "AgentPool API",
    "chain:84532",
    `address:${account.address.toLowerCase()}`,
    `nonce:${nonce.nonce}`,
    "method:POST",
    `path:${route}`,
    `body-sha256:${bodyHash}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  return json(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-address": account.address,
      "x-agent-nonce": nonce.nonce,
      "x-agent-signature": signature,
      "idempotency-key": crypto.randomUUID(),
    },
    body: bodyText,
  });
}

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Open one catalog-admitted Base Sepolia pilot assignment for an existing revealed bid.",
      "",
      "Required:",
      "  --bid-id <id>",
      "",
      "Optional:",
      `  --opportunity-id <id>  default ${pilot.opportunityId}`,
      "  --base-url <url>        default AGENTPOOL_BASE_URL or public gateway",
      "",
      "The script uses disposable .env.v41.local keys only. It never supports mainnet.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (requireEnv("V41_WALLET_PROFILE") !== "base-sepolia-disposable") {
  throw new Error("V41_PILOT_REQUIRES_DISPOSABLE_PROFILE");
}
if (manifest.chainId !== 84532 || manifest.network !== "Base Sepolia") {
  throw new Error("V41_PILOT_CHAIN_MISMATCH");
}

const bidId = argument("bid-id");
if (!bidId) throw new Error("--bid-id is required");
const opportunityId = argument("opportunity-id", pilot.opportunityId);
const isPilotRound =
  opportunityId === pilot.opportunityId ||
  (opportunityId.startsWith(`${pilot.opportunityId}-r`) &&
    /^\d+$/u.test(opportunityId.slice(`${pilot.opportunityId}-r`.length)));
if (!isPilotRound) {
  throw new Error("V41_PILOT_ONLY_SUPPORTS_COMMITTED_FIXTURE");
}
const baseUrl = argument(
  "base-url",
  process.env.AGENTPOOL_BASE_URL ??
    "https://agentpool-protocol.asfu.chatgpt.site",
).replace(/\/+$/, "");

const deployer = privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"));
if (deployer.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("V41_PILOT_DEPLOYER_MISMATCH");
}
const catalog = Array.from({ length: 5 }, (_, index) => {
  const account = privateKeyToAccount(
    requireEnv(`V41_CATALOG_SIGNER_PRIVATE_KEY_${index + 1}`),
  );
  if (
    account.address.toLowerCase() !==
    manifest.catalogSigners[index].toLowerCase()
  ) {
    throw new Error("V41_PILOT_CATALOG_KEY_MISMATCH");
  }
  return account;
});

const [opportunityPayload, allocation] = await Promise.all([
  json(
    `${baseUrl}/api/v4.1/opportunities?market=BASIC&state=OPEN&agentCostApool=0&successProbabilityBps=7500`,
  ),
  json(
    `${baseUrl}/api/v4.1/opportunities/${encodeURIComponent(opportunityId)}/allocation`,
  ),
]);
const opportunity = opportunityPayload.opportunities.find(
  (candidate) => candidate.id === opportunityId,
);
const bid = allocation.rankedBids.find((candidate) => candidate.id === bidId);
if (!opportunity || !bid) {
  throw new Error("V41_PILOT_OPEN_OPPORTUNITY_OR_REVEALED_BID_NOT_FOUND");
}
if (
  BigInt(bid.price_apool) <= 0n ||
  BigInt(bid.price_apool) > BigInt(opportunity.maxBudgetApool)
) {
  throw new Error("V41_PILOT_BID_OUTSIDE_BUDGET");
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport,
});
if ((await publicClient.getChainId()) !== 84532) {
  throw new Error("V41_PILOT_CHAIN_MISMATCH");
}

const worker = getAddress(bid.bidder_address);
const vault = getAddress(manifest.contracts.basicVault);
const rewardApool = String(bid.price_apool);
const amount = parseUnits(rewardApool, manifest.token.decimals);
const recipients = [worker];
const amounts = [amount];
const amountsApool = [rewardApool];
const attempt = crypto.randomUUID();
const assignmentId = v41Hash({
  kind: pilot.version,
  opportunityId,
  bidId,
  worker: worker.toLowerCase(),
  attempt,
});
const specificationHash = opportunity.specificationHash;
const deliveryHash = keccak256(toBytes(stableJson(pilot.expectedResult)));
const proof = toHex(pilot.proofText);
const expectedEvidenceHash = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [specificationHash, deliveryHash, keccak256(proof)],
  ),
);
const payoutRoot = keccak256(
  encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }],
    [recipients, amounts],
  ),
);
const artifactId = v41Hash({
  kind: "agentpool-v41-pilot-artifact",
  assignmentId,
});
const provenanceHash = v41Hash({
  opportunityId,
  bidId,
  worker: worker.toLowerCase(),
});
const licenseHash = keccak256(toBytes(pilot.license));
const zeroHash = `0x${"0".repeat(64)}`;
const block = await publicClient.getBlock();
const deadline = Math.min(
  Math.floor(Number(opportunity.deadlineAt) / 1_000),
  Number(block.timestamp + 7_200n),
);
if (deadline <= Number(block.timestamp) + 300) {
  throw new Error("V41_PILOT_DEADLINE_TOO_CLOSE");
}

const taskAdmission = {
  assignmentId,
  worker,
  reservedPayout: amount,
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
      message: taskAdmission,
    }),
  ),
);
const openHash = await walletClient.writeContract({
  account: deployer,
  address: vault,
  abi: vaultAbi,
  functionName: "openAssignment",
  args: [
    assignmentId,
    worker,
    amount,
    deadline,
    specificationHash,
    expectedEvidenceHash,
    payoutRoot,
    artifactId,
    provenanceHash,
    licenseHash,
    zeroHash,
    signatures,
  ],
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash: openHash,
  confirmations: 2,
});
if (receipt.status !== "success") {
  throw new Error(`V41_PILOT_OPEN_REVERTED:${openHash}`);
}

const settlementTerms = {
  deliveryHash,
  proof,
  recipients,
  amountsApool,
  artifactContentHash: deliveryHash,
  task: pilot.task,
};
const indexed = await signedWrite(
  deployer,
  baseUrl,
  `/api/v4.1/opportunities/${encodeURIComponent(opportunityId)}/award`,
  {
    bidId,
    txHash: openHash,
    settlementTerms,
  },
);
const output = {
  ok: true,
  testnetOnly: true,
  chainId: 84532,
  opportunityId,
  bidId,
  assignmentId,
  worker,
  rewardApool,
  task: pilot.task,
  expectedResultHash: deliveryHash,
  openTransactionHash: openHash,
  receipt: `https://sepolia.basescan.org/tx/${openHash}`,
  gateway: indexed,
  next:
    "The worker discovers this assignment through the local MCP, solves the task, then accepts, delivers, and settles with its own Base Sepolia test wallet.",
};
const outputDirectory = path.join(root, "outputs", "v41-pilots");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `${assignmentId.slice(2)}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...output, outputPath })}\n`);
