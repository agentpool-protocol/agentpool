import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const parentPath = path.join(root, "deployments", "84532.v43.5.json");
const manifestPath = path.join(root, "deployments", "84532.v43.7.json");
const partialPath = path.join(root, "deployments", "84532.v43.7.partial.json");
if (fs.existsSync(manifestPath)) throw new Error("V437_ALREADY_DEPLOYED");
const parent = JSON.parse(fs.readFileSync(parentPath, "utf8"));
if (parent.chainId !== 84532 || parent.version !== "4.3.5-staged-autonomy-alpha") {
  throw new Error("V437_PARENT_MANIFEST_INVALID");
}
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL_MISSING");
if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY_MISSING");

const account = privateKeyToAccount(privateKey);
if (account.address.toLowerCase() !== parent.deployer.toLowerCase()) {
  throw new Error("V437_DEPLOYER_MISMATCH");
}
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
if ((await client.getChainId()) !== 84532) throw new Error("V437_CHAIN_MISMATCH");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
const poolArtifact = artifact("AgentPoolV437SelfBootstrapPool");
const tokenArtifact = artifact("AgentPoolV43Token");
const caps = {
  maxItemQuote: parseEther("2"),
  maxIssueBudget: parseEther("5"),
  daily: parseEther("5"),
  lifetime: parseEther("10"),
  maxItemsPerIssue: 8,
  maxIssueLifetime: 30 * 86_400,
};
const constructorArgs = [
  parent.contracts.token,
  parent.contracts.systemIssueGate,
  parent.contracts.contributionLedger,
  parent.contracts.objectiveVerifier,
  parent.financeInvariantHash,
  caps.maxItemQuote,
  caps.maxIssueBudget,
  caps.daily,
  caps.lifetime,
  caps.maxItemsPerIssue,
  caps.maxIssueLifetime,
];
const balance = await client.getBalance({ address: account.address });
const tokenBalance = await client.readContract({
  address: parent.contracts.token,
  abi: tokenArtifact.abi,
  functionName: "balanceOf",
  args: [account.address],
});
if (tokenBalance < caps.lifetime) {
  throw new Error(
    `V437_DEPLOYER_TAPOOL_TOO_LOW:${formatUnits(tokenBalance, 18)}:10`,
  );
}

const state = fs.existsSync(partialPath)
  ? JSON.parse(fs.readFileSync(partialPath, "utf8"))
  : {
      version: "4.3.7-self-bootstrap-overlay-alpha",
      parentRelease: parent.version,
      chainId: 84532,
      network: "Base Sepolia",
      deployer: account.address,
      contracts: {},
      transactionHashes: [],
      gasUsed: "0",
    };
let gasUsed = BigInt(state.gasUsed ?? "0");
const save = () => {
  state.gasUsed = gasUsed.toString();
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(partialPath, `${JSON.stringify(state, null, 2)}\n`);
};

if (!state.contracts.selfBootstrapPool) {
  const estimate = await client.estimateGas({
    account: account.address,
    data: encodeDeployData({
      abi: poolArtifact.abi,
      bytecode: poolArtifact.bytecode,
      args: constructorArgs,
    }),
  });
  const gasPrice = await client.getGasPrice();
  const required = ((estimate + 180_000n) * gasPrice * 125n) / 100n;
  if (balance < required) {
    throw new Error(
      `V437_DEPLOYER_GAS_TOO_LOW:${formatEther(balance)}:${formatEther(required)}`,
    );
  }
  const hash = await wallet.deployContract({
    account,
    abi: poolArtifact.abi,
    bytecode: poolArtifact.bytecode,
    args: constructorArgs,
  });
  state.transactionHashes.push(hash);
  save();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`V437_DEPLOY_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  state.contracts.selfBootstrapPool = getAddress(receipt.contractAddress);
  save();
}
const pool = state.contracts.selfBootstrapPool;
let code = "0x";
for (let attempt = 1; attempt <= 6; attempt += 1) {
  code = await client.getCode({ address: pool });
  if (code && code !== "0x") break;
  await wait(attempt * 1_000);
}
if (!code || code === "0x") throw new Error("V437_POOL_CODE_MISSING");

let currentAllowance = await client.readContract({
  address: parent.contracts.token,
  abi: tokenArtifact.abi,
  functionName: "allowance",
  args: [account.address, pool],
});
if (currentAllowance < caps.lifetime) {
  const hash = await wallet.writeContract({
    account,
    address: parent.contracts.token,
    abi: tokenArtifact.abi,
    functionName: "approve",
    args: [pool, caps.lifetime],
  });
  state.transactionHashes.push(hash);
  save();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") throw new Error(`V437_APPROVE_FAILED:${hash}`);
  gasUsed += receipt.gasUsed;
  save();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    currentAllowance = await client.readContract({
      address: parent.contracts.token,
      abi: tokenArtifact.abi,
      functionName: "allowance",
      args: [account.address, pool],
    });
    if (currentAllowance >= caps.lifetime) break;
    await wait(attempt * 1_000);
  }
  if (currentAllowance < caps.lifetime) {
    throw new Error("V437_APPROVAL_NOT_VISIBLE_AFTER_CONFIRMATION");
  }
}
const funded = await client.readContract({
  address: pool,
  abi: poolArtifact.abi,
  functionName: "totalFunded",
});
if (funded === 0n) {
  const hash = await wallet.writeContract({
    account,
    address: pool,
    abi: poolArtifact.abi,
    functionName: "fund",
    args: [caps.lifetime],
  });
  state.transactionHashes.push(hash);
  save();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") throw new Error(`V437_FUND_FAILED:${hash}`);
  gasUsed += receipt.gasUsed;
  save();
} else if (funded !== caps.lifetime) {
  throw new Error(`V437_PARTIAL_FUNDING_UNEXPECTED:${funded}`);
}

const manifest = {
  version: state.version,
  chainId: 84532,
  network: "Base Sepolia",
  testnetOnly: true,
  parentRelease: parent.version,
  parentManifest: "deployments/84532.v43.5.json",
  financeInvariantHash: parent.financeInvariantHash,
  mode: "SELF_BOOTSTRAP",
  independenceClaim: false,
  sameAgentRolesAllowed: true,
  payoutRule:
    "sum of precommitted accepted work-item quotes with distinct objective receipts",
  createsWorkPower: false,
  canRecommendRelease: false,
  canMint: false,
  candidateStatus: "INCUBATION_PROVEN",
  graduation:
    "one-way when v4.3.5 transitionReady, contribution ledger MATURE, or finite pool exhausted",
  caps: {
    maxItemQuoteApool: "2",
    maxIssueBudgetApool: "5",
    dailyApool: "5",
    lifetimeApool: "10",
    maxItemsPerIssue: caps.maxItemsPerIssue,
    maxIssueLifetimeSeconds: caps.maxIssueLifetime,
  },
  allowedScopes: [
    "RUNNER",
    "MCP",
    "INDEXER",
    "EXPLORER",
    "VERIFIER_TESTS",
    "ADAPTER",
  ],
  contracts: {
    token: parent.contracts.token,
    stageGate: parent.contracts.systemIssueGate,
    contributionLedger: parent.contracts.contributionLedger,
    objectiveVerifier: parent.contracts.objectiveVerifier,
    selfBootstrapPool: pool,
  },
  transactionHashes: state.transactionHashes,
  gasUsed: gasUsed.toString(),
  deployedAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    pool,
    fundedApool: "10",
    transactions: manifest.transactionHashes,
    remainingTestEth: formatEther(
      await client.getBalance({ address: account.address }),
    ),
  })}\n`,
);
