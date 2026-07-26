import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const chainId = 84532;
const sourceManifestPath = path.join(root, "deployments", "84532.json");
const targetManifestPath = path.join(root, "deployments", "84532.v3.json");
const partialManifestPath = path.join(root, "deployments", "84532.v3.partial.json");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (fs.existsSync(targetManifestPath)) {
  throw new Error(
    "deployments/84532.v3.json already exists; refusing to deploy a second v3 suite",
  );
}
const source = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
if (source.chainId !== chainId || source.version !== 2) {
  throw new Error("deployments/84532.json is not the verified Base Sepolia v2 manifest");
}

const rpcUrl = requireEnv("AGENTPOOL_RPC_URL");
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
if (account.address.toLowerCase() !== source.deployer.toLowerCase()) {
  throw new Error("DEPLOYER_PRIVATE_KEY does not match the existing testnet deployer");
}
const transport = http(rpcUrl);
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
const client = createPublicClient({ chain: baseSepolia, transport });
if ((await client.getChainId()) !== chainId) throw new Error("RPC chain mismatch");

const balance = await client.getBalance({ address: account.address });
const minimumBalance = BigInt(
  process.env.MIN_V3_DEPLOYER_BALANCE_WEI ?? "20000000000000",
);
if (balance < minimumBalance) {
  throw new Error(
    `DEPLOYER_BALANCE_TOO_LOW: ${formatEther(balance)} ETH; minimum ${formatEther(minimumBalance)} ETH`,
  );
}

const protocolConfig = JSON.parse(
  fs.readFileSync(path.join(root, "protocol-config.json"), "utf8"),
);
const verifierConfigs = protocolConfig.bootstrapVerifiers;
if (
  !Array.isArray(verifierConfigs) ||
  verifierConfigs.length === 0 ||
  verifierConfigs.some(
    ({ name, validationFeeApool }) =>
      !/^[a-z0-9][a-z0-9-]{2,79}$/u.test(name) ||
      !Number.isInteger(validationFeeApool) ||
      validationFeeApool < 10 ||
      validationFeeApool > 30 ||
      validationFeeApool % 10 !== 0,
  )
) {
  throw new Error("protocol-config.json contains invalid fixed verifier fees");
}
const verifierIds = verifierConfigs.map(({ name }) => keccak256(toBytes(name)));
const implementationHash = requireEnv("INITIAL_VERIFIER_IMPLEMENTATION_HASH");
if (!/^0x[0-9a-fA-F]{64}$/u.test(implementationHash) || /^0x0{64}$/u.test(implementationHash)) {
  throw new Error("INITIAL_VERIFIER_IMPLEMENTATION_HASH must be a nonzero bytes32");
}

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
}

const transactionHashes = [];
const newContracts = {};
function writePartial() {
  fs.writeFileSync(
    partialManifestPath,
    `${JSON.stringify(
      {
        version: 3,
        chainId,
        sourceManifest: "deployments/84532.json",
        deployer: account.address,
        sharedContracts: source.contracts,
        contracts: newContracts,
        transactionHashes,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function deploy(name, args = [], key) {
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
    throw new Error(`${name} deployment failed: ${hash}`);
  }
  newContracts[key] = receipt.contractAddress;
  writePartial();
  console.log(`${name}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function write(name, address, functionName, args = []) {
  const hash = await wallet.writeContract({
    account,
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  transactionHashes.push(hash);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${name}.${functionName} failed: ${hash}`);
  }
  writePartial();
  return receipt;
}

const token = getAddress(source.contracts.token);
const timelock = getAddress(source.contracts.timelock);
const securityTreasury = getAddress(source.allocations.securityTreasury);
const verifierAdapter = getAddress(source.bootstrap.verifierAdapter);
const validators = source.bootstrap.validators.map((address) => getAddress(address));
const policyVersion = Number(source.bootstrap.policyVersion);

console.log(
  `Deploying AgentPool v3 trade suite on Base Sepolia from ${account.address}; balance ${formatEther(balance)} ETH`,
);
const registry = await deploy("AgentPoolRegistry", [account.address], "registry");
const randomnessProvider = await deploy(
  "MockRandomnessProvider",
  [account.address],
  "randomnessProvider",
);
const oracle = await deploy(
  "AgentPoolWorkOracle",
  [account.address, registry, randomnessProvider],
  "oracle",
);
const jobEscrow = await deploy(
  "AgentPoolJobEscrow",
  [token, registry, account.address, securityTreasury],
  "jobEscrow",
);
const projectResolver = await deploy(
  "AgentPoolProjectResolver",
  [account.address, validators, policyVersion],
  "projectResolver",
);
const projectEscrow = await deploy(
  "AgentPoolProjectEscrow",
  [token, registry, account.address, securityTreasury],
  "projectEscrow",
);

await write("MockRandomnessProvider", randomnessProvider, "setConsumer", [oracle]);
for (const [index, verifierId] of verifierIds.entries()) {
  await write("AgentPoolRegistry", registry, "configureVerifier", [
    verifierId,
    verifierAdapter,
    implementationHash,
    verifierConfigs[index].validationFeeApool,
    false,
    true,
  ]);
}
for (const validator of validators) {
  await write("AgentPoolWorkOracle", oracle, "setEvaluator", [validator, true]);
}
await write("AgentPoolWorkOracle", oracle, "setEscrow", [jobEscrow]);
await write("AgentPoolJobEscrow", jobEscrow, "setResolver", [oracle]);
await write("AgentPoolProjectResolver", projectResolver, "configureProjectEscrow", [
  projectEscrow,
]);
await write("AgentPoolProjectEscrow", projectEscrow, "setResolver", [
  projectResolver,
]);

for (const [name, address] of [
  ["AgentPoolRegistry", registry],
  ["MockRandomnessProvider", randomnessProvider],
  ["AgentPoolWorkOracle", oracle],
  ["AgentPoolJobEscrow", jobEscrow],
  ["AgentPoolProjectResolver", projectResolver],
  ["AgentPoolProjectEscrow", projectEscrow],
]) {
  await write(name, address, "transferOwnership", [timelock]);
}

const latestBlock = await client.getBlockNumber();
const manifest = {
  version: 3,
  chainId,
  network: "Base Sepolia",
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  activationBlock: latestBlock.toString(),
  sourceManifest: "deployments/84532.json",
  sharedContracts: {
    token,
    founderVesting: source.contracts.founderVesting,
    benchmarkRewardVault: source.contracts.benchmarkRewardVault,
    timelock,
    license: source.contracts.license,
  },
  contracts: newContracts,
  allocations: source.allocations,
  bootstrap: {
    verifiers: verifierConfigs.map((verifier, index) => ({
      name: verifier.name,
      id: verifierIds[index],
      validationFeeApool: verifier.validationFeeApool,
    })),
    verifierAdapter,
    verifierImplementationHash: implementationHash,
    validators,
    policyVersion,
  },
  economics: {
    workerPriceFeeBps: 0,
    validatorShareBps: 9000,
    burnShareBps: 0,
    securityShareBps: 1000,
    minimumVerifiedJobPriceApool: 1000,
    disputeFeeApool: 50,
    operationalMiningDailyCapApool: 10000,
    ownerMiningDailyCapApool: 500,
  },
  transactionHashes,
};
fs.writeFileSync(targetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (fs.existsSync(partialManifestPath)) fs.unlinkSync(partialManifestPath);
console.log(`AgentPool v3 manifest: ${targetManifestPath}`);
