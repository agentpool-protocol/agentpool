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
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const parentPath = path.join(root, "deployments", "84532.v43.5.json");
const manifestPath = path.join(root, "deployments", "84532.v43.9.json");
const partialPath = path.join(
  root,
  "deployments",
  "84532.v43.9.partial.json",
);
if (fs.existsSync(manifestPath)) throw new Error("V439_ALREADY_DEPLOYED");
const parent = JSON.parse(fs.readFileSync(parentPath, "utf8"));
if (
  parent.chainId !== 84_532 ||
  parent.version !== "4.3.5-staged-autonomy-alpha"
) {
  throw new Error("V439_PARENT_MANIFEST_INVALID");
}

const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
const deployerKey = (
  process.env.V439_DEPLOYER_PRIVATE_KEY ??
  process.env.DEPLOYER_PRIVATE_KEY
)?.trim();
const funderKey = (
  process.env.V439_FUNDER_PRIVATE_KEY ??
  process.env.TESTNET_AUTHOR_PRIVATE_KEY
)?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL_MISSING");
if (!deployerKey) throw new Error("V439_DEPLOYER_PRIVATE_KEY_MISSING");
if (!funderKey) throw new Error("V439_FUNDER_PRIVATE_KEY_MISSING");

const deployer = privateKeyToAccount(deployerKey);
const funder = privateKeyToAccount(funderKey);
const transport = http(rpcUrl, { timeout: 60_000, retryCount: 4 });
const client = createPublicClient({ chain: baseSepolia, transport });
const deployerWallet = createWalletClient({
  account: deployer,
  chain: baseSepolia,
  transport,
});
const funderWallet = createWalletClient({
  account: funder,
  chain: baseSepolia,
  transport,
});
if ((await client.getChainId()) !== 84_532) {
  throw new Error("V439_CHAIN_MISMATCH");
}

const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
const poolArtifact = artifact("AgentPoolV439CandidateRewardPool");
const tokenArtifact = artifact("AgentPoolV43Token");
const caps = {
  maxReporterQuote: parseEther("0.5"),
  maxCandidateQuote: parseEther("2"),
  maxValidatorQuote: parseEther("0.5"),
  maxIssueBudget: parseEther("5"),
  daily: parseEther("5"),
  lifetime: parseEther("5"),
  passScoreBps: 8_000,
  minimumValidators: 1,
  minimumValidatorGroups: 1,
  maxCandidates: 8,
  maxValidators: 5,
  maxIssueLifetime: 7 * 86_400,
};
const constructorArgs = [
  parent.contracts.token,
  parent.contracts.contributionLedger,
  caps.maxReporterQuote,
  caps.maxCandidateQuote,
  caps.maxValidatorQuote,
  caps.maxIssueBudget,
  caps.daily,
  caps.lifetime,
  caps.passScoreBps,
  caps.minimumValidators,
  caps.minimumValidatorGroups,
  caps.maxCandidates,
  caps.maxValidators,
  caps.maxIssueLifetime,
];

const state = fs.existsSync(partialPath)
  ? JSON.parse(fs.readFileSync(partialPath, "utf8"))
  : {
      version: "4.3.9-candidate-reward-overlay-alpha",
      parentRelease: parent.version,
      chainId: 84_532,
      network: "Base Sepolia",
      deployer: deployer.address,
      funder: funder.address,
      contracts: {},
      transactionHashes: [],
      gasUsed: "0",
    };
if (
  state.deployer.toLowerCase() !== deployer.address.toLowerCase() ||
  state.funder.toLowerCase() !== funder.address.toLowerCase()
) {
  throw new Error("V439_PARTIAL_IDENTITY_MISMATCH");
}
let gasUsed = BigInt(state.gasUsed ?? "0");
const save = () => {
  state.gasUsed = gasUsed.toString();
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(partialPath, `${JSON.stringify(state, null, 2)}\n`);
};
const waitFor = async (hash, label) => {
  state.transactionHashes.push(hash);
  save();
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`V439_${label}_FAILED:${hash}`);
  }
  gasUsed += receipt.gasUsed;
  save();
  return receipt;
};
const requireGas = async (account, estimatedGas, label) => {
  const [balance, gasPrice] = await Promise.all([
    client.getBalance({ address: account }),
    client.getGasPrice(),
  ]);
  const required = (estimatedGas * gasPrice * 125n) / 100n;
  if (balance < required) {
    throw new Error(
      `V439_${label}_GAS_TOO_LOW:${formatEther(balance)}:${formatEther(required)}`,
    );
  }
};

if (!state.contracts.candidateRewardPool) {
  const data = encodeDeployData({
    abi: poolArtifact.abi,
    bytecode: poolArtifact.bytecode,
    args: constructorArgs,
  });
  const estimatedGas = await client.estimateGas({
    account: deployer.address,
    data,
  });
  await requireGas(deployer.address, estimatedGas, "DEPLOYER");
  const hash = await deployerWallet.deployContract({
    account: deployer,
    abi: poolArtifact.abi,
    bytecode: poolArtifact.bytecode,
    args: constructorArgs,
  });
  const receipt = await waitFor(hash, "DEPLOY");
  if (!receipt.contractAddress) {
    throw new Error("V439_CONTRACT_ADDRESS_MISSING");
  }
  state.contracts.candidateRewardPool = getAddress(
    receipt.contractAddress,
  );
  save();
}
const pool = state.contracts.candidateRewardPool;
const code = await client.getCode({ address: pool });
if (!code || code === "0x") throw new Error("V439_POOL_CODE_MISSING");

const tokenBalance = await client.readContract({
  address: parent.contracts.token,
  abi: tokenArtifact.abi,
  functionName: "balanceOf",
  args: [funder.address],
});
if (tokenBalance < caps.lifetime) {
  throw new Error(
    `V439_FUNDER_TAPOOL_TOO_LOW:${formatUnits(tokenBalance, 18)}:5`,
  );
}
let allowance = await client.readContract({
  address: parent.contracts.token,
  abi: tokenArtifact.abi,
  functionName: "allowance",
  args: [funder.address, pool],
});
if (allowance < caps.lifetime) {
  const estimatedGas = await client.estimateContractGas({
    account: funder.address,
    address: parent.contracts.token,
    abi: tokenArtifact.abi,
    functionName: "approve",
    args: [pool, caps.lifetime],
  });
  await requireGas(funder.address, estimatedGas, "FUNDER_APPROVE");
  await waitFor(
    await funderWallet.writeContract({
      account: funder,
      address: parent.contracts.token,
      abi: tokenArtifact.abi,
      functionName: "approve",
      args: [pool, caps.lifetime],
    }),
    "APPROVE",
  );
  allowance = await client.readContract({
    address: parent.contracts.token,
    abi: tokenArtifact.abi,
    functionName: "allowance",
    args: [funder.address, pool],
  });
  if (allowance < caps.lifetime) {
    throw new Error("V439_APPROVAL_NOT_VISIBLE");
  }
}

const funded = await client.readContract({
  address: pool,
  abi: poolArtifact.abi,
  functionName: "totalFunded",
});
if (funded === 0n) {
  const estimatedGas = await client.estimateContractGas({
    account: funder.address,
    address: pool,
    abi: poolArtifact.abi,
    functionName: "fund",
    args: [caps.lifetime],
  });
  await requireGas(funder.address, estimatedGas, "FUNDER_FUND");
  await waitFor(
    await funderWallet.writeContract({
      account: funder,
      address: pool,
      abi: poolArtifact.abi,
      functionName: "fund",
      args: [caps.lifetime],
    }),
    "FUND",
  );
} else if (funded !== caps.lifetime) {
  throw new Error(`V439_PARTIAL_FUNDING_UNEXPECTED:${funded}`);
}

const manifest = {
  version: state.version,
  chainId: 84_532,
  network: "Base Sepolia",
  testnetOnly: true,
  parentRelease: parent.version,
  parentManifest: "deployments/84532.v43.5.json",
  mode: "CANDIDATE_REWARD_INCUBATION",
  quoteTiming:
    "reporter quote at Issue open, implementer quote before candidate work, validator quote before reveal",
  payoutRule:
    "sum of the selected implementer bid, proven reporter quote, and every valid revealed validator bid",
  sameAgentRolesAllowed: true,
  independenceClaim: false,
  createsWorkPower: false,
  canRecommendRelease: false,
  canMint: false,
  contracts: {
    token: parent.contracts.token,
    contributionLedger: parent.contracts.contributionLedger,
    candidateRewardPool: pool,
  },
  caps: {
    maxReporterQuoteApool: "0.5",
    maxCandidateQuoteApool: "2",
    maxValidatorQuoteApool: "0.5",
    maxIssueBudgetApool: "5",
    dailyApool: "5",
    lifetimeApool: "5",
    passScoreBps: caps.passScoreBps,
    minimumValidators: caps.minimumValidators,
    minimumValidatorGroups: caps.minimumValidatorGroups,
    maxCandidates: caps.maxCandidates,
    maxValidators: caps.maxValidators,
    maxIssueLifetimeSeconds: caps.maxIssueLifetime,
  },
  deployer: deployer.address,
  funder: funder.address,
  transactionHashes: state.transactionHashes,
  gasUsed: gasUsed.toString(),
  deployedAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    contract: pool,
    fundedApool: "5",
    transactionHashes: state.transactionHashes,
  })}\n`,
);
