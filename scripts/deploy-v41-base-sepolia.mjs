import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  getAddress,
  getCreate2Address,
  http,
  isAddress,
  keccak256,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const manifestPath = path.join(root, "deployments", "84532.v41.json");
const partialPath = path.join(root, "deployments", "84532.v41.partial.json");
if (fs.existsSync(manifestPath)) {
  throw new Error("V41_ALREADY_DEPLOYED: deployments/84532.v41.json exists");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}

const chainId = 84532;
const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const account = privateKeyToAccount(requireEnv("V41_DEPLOYER_PRIVATE_KEY"));
const catalogSigners = Array.from({ length: 5 }, (_, index) =>
  requireEnv(`V41_CATALOG_SIGNER_${index + 1}`),
).map((address) => {
  if (!isAddress(address)) throw new Error("V41_CATALOG_SIGNER_INVALID");
  return getAddress(address);
});
for (let index = 0; index < catalogSigners.length; index++) {
  if (
    catalogSigners[index].toLowerCase() === account.address.toLowerCase() ||
    (index > 0 && BigInt(catalogSigners[index]) <= BigInt(catalogSigners[index - 1]))
  ) {
    throw new Error(
      "V41_CATALOG_SIGNERS must be unique, numerically sorted, and exclude the deployer",
    );
  }
}
const genesisStart = Number(requireEnv("V41_GENESIS_TIMESTAMP"));
if (
  !Number.isSafeInteger(genesisStart) ||
  genesisStart < Math.floor(Date.now() / 1_000) - 600 ||
  genesisStart > Math.floor(Date.now() / 1_000) + 3_600
) {
  throw new Error("V41_GENESIS_TIMESTAMP must be within -10/+60 minutes of now");
}

const transport = http(rpcUrl);
const client = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
if ((await client.getChainId()) !== chainId) throw new Error("V41_CHAIN_MISMATCH");
const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V41_DEPLOYER_BALANCE_WEI ?? "30000000000000",
);
if (balance < minimumBalance) {
  throw new Error(
    `V41_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
  );
}

const transactionHashes = [];
const contracts = {};
function savePartial() {
  fs.writeFileSync(
    partialPath,
    `${JSON.stringify({
      version: "4.1.0-alpha",
      chainId,
      deployer: account.address,
      catalogSigners,
      catalogQuorum: 3,
      genesisStart,
      contracts,
      transactionHashes,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}
async function deploy(name, args, key) {
  const compiled = artifact(name);
  const hash = await wallet.deployContract({
    account,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  transactionHashes.push(hash);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name}_DEPLOYMENT_FAILED:${hash}`);
  }
  contracts[key] = receipt.contractAddress;
  savePartial();
  return receipt.contractAddress;
}
async function write(name, address, functionName, args) {
  const hash = await wallet.writeContract({
    account,
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  transactionHashes.push(hash);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name}.${functionName}_FAILED:${hash}`);
  savePartial();
}

const token = await deploy("AgentPoolV41Token", [account.address], "token");
const objectiveVerifier = await deploy(
  "AgentPoolV41HashVerifier",
  [],
  "objectiveVerifier",
);
const controller = await deploy(
  "AgentPoolV41EmissionController",
  [
    token,
    account.address,
    objectiveVerifier,
    catalogSigners,
    3,
    genesisStart,
  ],
  "controller",
);
const releaseRegistry = await deploy(
  "AgentPoolV41ReleaseRegistry",
  [controller],
  "releaseRegistry",
);
const artifactRegistry = await deploy(
  "AgentPoolV41ArtifactRegistry",
  [controller],
  "artifactRegistry",
);
await deploy(
  "AgentPoolV41UserEscrow",
  [token],
  "userEscrow",
);
await write(
  "AgentPoolV41EmissionController",
  controller,
  "configureRegistries",
  [releaseRegistry, artifactRegistry],
);
await write(
  "AgentPoolV41Token",
  token,
  "setEmissionController",
  [controller],
);

async function createVault(lane, saltText, key) {
  const salt = keccak256(toBytes(saltText));
  const epoch = 0;
  const issueHash = `0x${"0".repeat(64)}`;
  const predicted = getCreate2Address({
    from: controller,
    salt,
    bytecode: encodeDeployData({
      abi: artifact("AgentPoolV41EpochVault").abi,
      bytecode: artifact("AgentPoolV41EpochVault").bytecode,
      args: [controller, epoch, lane, issueHash, false],
    }),
  });
  await write(
    "AgentPoolV41EmissionController",
    controller,
    "createEpochVault",
    [epoch, lane, issueHash, false, salt],
  );
  contracts[key] = predicted;
}
await createVault(0, "agentpool-v41-capability-epoch-0", "capabilityVault");
await createVault(1, "agentpool-v41-basic-epoch-0", "basicVault");
await createVault(3, "agentpool-v41-validation-epoch-0", "validationVault");

const totalSupply = await client.readContract({
  address: token,
  abi: artifact("AgentPoolV41Token").abi,
  functionName: "totalSupply",
});
if (totalSupply !== 0n) throw new Error("V41_PREMINT_NOT_ZERO");

const manifest = {
  version: "4.1.0-alpha",
  chainId,
  network: "Base Sepolia",
  deployer: account.address,
  deployerHasRuntimeAuthority: false,
  catalogSigners,
  catalogQuorum: 3,
  genesisStart,
  token: {
    symbol: "tAPOOL",
    decimals: 18,
    maxSupplyApool: "1000000000000",
    premintApool: "0",
  },
  emission: {
    genesisCapBps: 50,
    genesisDays: 180,
    halfLifeYears: 8,
    capabilityCapBps: 500,
    experimentalProofCapBps: 100,
    issueCapBps: 1000,
  },
  contracts,
  transactionHashes,
  deployedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (fs.existsSync(partialPath)) fs.rmSync(partialPath);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    manifestPath,
    contracts,
    transactions: transactionHashes.length,
    premint: "0",
  })}\n`,
);
