import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const expectedChainId = 84532;
const requiredArtifacts = [
  "AgentPoolV41Token",
  "AgentPoolV41HashVerifier",
  "AgentPoolV41EmissionController",
  "AgentPoolV41ReleaseRegistry",
  "AgentPoolV41ArtifactRegistry",
  "AgentPoolV41UserEscrow",
  "AgentPoolV41EpochVault",
];
const missing = [];

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) missing.push(name);
  return value ?? "";
}

const rpcUrl = env("AGENTPOOL_RPC_URL");
const deployerPrivateKey = env("V41_DEPLOYER_PRIVATE_KEY");
const signerInputs = Array.from({ length: 5 }, (_, index) =>
  env(`V41_CATALOG_SIGNER_${index + 1}`),
);
const genesisInput = env("V41_GENESIS_TIMESTAMP");

if (missing.length > 0) {
  process.stdout.write(
    `${JSON.stringify({
      ready: false,
      network: "Base Sepolia",
      chainId: expectedChainId,
      missing,
      writesPerformed: false,
    })}\n`,
  );
  process.exitCode = 1;
} else {
  if (!/^0x[a-fA-F0-9]{64}$/.test(deployerPrivateKey)) {
    throw new Error("V41_DEPLOYER_PRIVATE_KEY_INVALID");
  }
  const deployer = privateKeyToAccount(deployerPrivateKey);
  const catalogSigners = signerInputs.map((address) => {
    if (!isAddress(address)) throw new Error("V41_CATALOG_SIGNER_INVALID");
    return getAddress(address);
  });
  for (let index = 0; index < catalogSigners.length; index += 1) {
    if (
      catalogSigners[index].toLowerCase() === deployer.address.toLowerCase() ||
      (index > 0 &&
        BigInt(catalogSigners[index]) <= BigInt(catalogSigners[index - 1]))
    ) {
      throw new Error(
        "V41_CATALOG_SIGNERS must be unique, numerically sorted, and exclude the deployer",
      );
    }
  }

  const genesisStart = Number(genesisInput);
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(genesisStart) ||
    genesisStart < now - 600 ||
    genesisStart > now + 3_600
  ) {
    throw new Error(
      "V41_GENESIS_TIMESTAMP must be within -10/+60 minutes of now",
    );
  }

  const artifactHashes = {};
  for (const name of requiredArtifacts) {
    const artifactPath = path.join(root, "artifacts", `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`V41_ARTIFACT_MISSING:${name}`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    if (!/^0x[a-fA-F0-9]+$/.test(artifact.bytecode ?? "")) {
      throw new Error(`V41_ARTIFACT_BYTECODE_INVALID:${name}`);
    }
    artifactHashes[name] = keccak256(artifact.bytecode);
  }

  if (fs.existsSync(path.join(root, "deployments", "84532.v41.json"))) {
    throw new Error("V41_ALREADY_DEPLOYED");
  }
  if (fs.existsSync(path.join(root, "deployments", "84532.v41.partial.json"))) {
    throw new Error("V41_PARTIAL_DEPLOYMENT_REQUIRES_REVIEW");
  }

  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) throw new Error("V41_CHAIN_MISMATCH");
  const balance = await client.getBalance({ address: deployer.address });
  const minimumBalance = BigInt(
    process.env.MIN_V41_DEPLOYER_BALANCE_WEI ?? "30000000000000",
  );
  if (balance < minimumBalance) {
    throw new Error(
      `V41_DEPLOYER_BALANCE_TOO_LOW:${formatEther(balance)}:${formatEther(minimumBalance)}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      network: "Base Sepolia",
      chainId,
      deployer: deployer.address,
      deployerTestEth: formatEther(balance),
      catalogSigners,
      catalogQuorum: 3,
      genesisStart,
      minimumBalanceWei: minimumBalance.toString(),
      artifactHashes,
      writesPerformed: false,
    })}\n`,
  );
}
