import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import {
  bootstrapDeliveryArtifact,
  bootstrapDeliveryHash,
  verifyPublishedBootstrapSpecifications,
} from "./v44-bootstrap-specifications.mjs";
import { canonicalJson } from "./v44-autonomy-safety.mjs";
import { bufferGasEstimate, configuredEip1559Fees } from "../../lib/evm-gas.mjs";

export const V44_TESTNET_CHAIN_ID = 84_532;
export const V44_TESTNET_WALLET_SCHEMA = "agentpool.testnet.v44.wallet/v1";
const DEPLOYMENT_SCHEMA = "agentpool.testnet.v44.deployment/v1";
const HASH = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/u;
const PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/u;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireFile(filePath, code) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(code);
  return resolved;
}

function artifactAbi(name, root = process.cwd()) {
  const artifactPath = requireFile(
    path.join(root, "artifacts", `${name}.json`),
    `V44_PARTICIPANT_ARTIFACT_MISSING:${name}`,
  );
  return readJson(artifactPath).abi;
}

function valueAtPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("V44_PARTICIPANT_EVIDENCE_POINTER_INVALID");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => {
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      ) {
        throw new Error("V44_PARTICIPANT_EVIDENCE_POINTER_MISSING");
      }
      return current[segment];
    }, value);
}

export function parseV44TestnetManifest(filePath) {
  const resolved = requireFile(
    filePath,
    "V44_PARTICIPANT_DEPLOYMENT_MANIFEST_MISSING",
  );
  const manifest = readJson(resolved);
  if (
    manifest.schema !== DEPLOYMENT_SCHEMA ||
    manifest.chainId !== V44_TESTNET_CHAIN_ID ||
    manifest.network !== "Base Sepolia" ||
    manifest.phase !== "BOOTSTRAP" ||
    manifest.version !== "4.4.0-ownerless-mainnet-candidate" ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(manifest.campaignId ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit ?? "") ||
    !ADDRESS.test(manifest.contracts?.taskMarket ?? "") ||
    !ADDRESS.test(manifest.contracts?.token ?? "") ||
    !ADDRESS.test(manifest.contracts?.contributionLedger ?? "") ||
    !ADDRESS.test(manifest.contracts?.capacityRegistry ?? "") ||
    !ADDRESS.test(manifest.contracts?.proofRegistry ?? "") ||
    manifest.deployerHasRuntimeAuthority !== false ||
    manifest.token?.premintApool !== "0"
  ) {
    throw new Error("V44_PARTICIPANT_DEPLOYMENT_MANIFEST_INVALID");
  }
  return { manifest, manifestPath: resolved };
}

export function defaultV44WalletPath(env = process.env) {
  return path.resolve(
    env.AGENTPOOL_V44_WALLET_FILE ??
      path.join(
        env.AGENTPOOL_V44_HOME ?? path.join(os.homedir(), ".agentpool-v44-testnet"),
        "base-sepolia-wallet.json",
      ),
  );
}

export function readV44PrivateKey({ env = process.env, walletPath } = {}) {
  const fromEnvironment = env.AGENTPOOL_V44_PRIVATE_KEY?.trim();
  if (fromEnvironment) {
    if (!PRIVATE_KEY.test(fromEnvironment)) {
      throw new Error("V44_PARTICIPANT_PRIVATE_KEY_INVALID");
    }
    return fromEnvironment;
  }
  const resolved = walletPath ?? defaultV44WalletPath(env);
  if (!fs.existsSync(resolved)) return null;
  const stored = readJson(resolved);
  if (
    stored.chainId !== V44_TESTNET_CHAIN_ID ||
    stored.network !== "Base Sepolia" ||
    !PRIVATE_KEY.test(stored.privateKey ?? "")
  ) {
    throw new Error("V44_PARTICIPANT_WALLET_INVALID");
  }
  const account = privateKeyToAccount(stored.privateKey);
  if (
    stored.address &&
    stored.address.toLowerCase() !== account.address.toLowerCase()
  ) {
    throw new Error("V44_PARTICIPANT_WALLET_ADDRESS_MISMATCH");
  }
  return stored.privateKey;
}

export function createV44TestWallet({
  env = process.env,
  walletPath = defaultV44WalletPath(env),
} = {}) {
  if (env.AGENTPOOL_V44_PRIVATE_KEY || fs.existsSync(walletPath)) {
    throw new Error("V44_PARTICIPANT_WALLET_ALREADY_EXISTS");
  }
  fs.mkdirSync(path.dirname(walletPath), { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  fs.writeFileSync(
    walletPath,
    `${JSON.stringify(
      {
        schema: V44_TESTNET_WALLET_SCHEMA,
        network: "Base Sepolia",
        chainId: V44_TESTNET_CHAIN_ID,
        address: account.address,
        privateKey,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { address: account.address, walletPath };
}

export function bytes32(value) {
  return HASH.test(value ?? "") ? value : keccak256(toBytes(String(value)));
}

export function payoutRoot(recipients, amounts) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [recipients, amounts],
    ),
  );
}

export function proofRoundId(jobId, milestoneIndex) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint32" }],
      ["PROOF", jobId, milestoneIndex],
    ),
  );
}

export function jobIdFor(market, creator, nonce, planHash) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [BigInt(V44_TESTNET_CHAIN_ID), market, creator, nonce, planHash],
    ),
  );
}

export function loadV44BootstrapPublicEvidence({
  manifest,
  manifestPath,
  sourceEvidencePath,
  specificationsPath,
}) {
  const directory = path.dirname(manifestPath);
  const sourcePath = requireFile(
    sourceEvidencePath ??
      path.join(
        directory,
        `${path.basename(manifestPath, ".json")}.source-reproducibility.json`,
      ),
    "V44_PARTICIPANT_SOURCE_EVIDENCE_MISSING",
  );
  const specPath = requireFile(
    specificationsPath ??
      path.join(
        directory,
        `${path.basename(manifestPath, ".json")}.bootstrap-specifications.json`,
      ),
    "V44_PARTICIPANT_SPECIFICATIONS_MISSING",
  );
  const sourceEvidence = readJson(sourcePath);
  if (
    sourceEvidence.sourceCommit !== manifest.sourceCommit ||
    sourceEvidence.schema !== "agentpool.mainnet.v44.source-reproducibility/v1"
  ) {
    throw new Error("V44_PARTICIPANT_SOURCE_EVIDENCE_INVALID");
  }
  const published = verifyPublishedBootstrapSpecifications({
    filePath: specPath,
    deployment: manifest,
    sourceEvidence,
  });
  return {
    sourceEvidence,
    sourceEvidencePath: sourcePath,
    specifications: published.specifications,
    specificationsPath: specPath,
  };
}

export function buildV44BootstrapDelivery({
  manifest,
  publicEvidence,
  objectiveIndex,
}) {
  const specification = publicEvidence.specifications.objectives[objectiveIndex];
  const committed = manifest.bootstrap.objectives[objectiveIndex];
  if (!specification || !committed) {
    throw new Error("V44_PARTICIPANT_OBJECTIVE_INDEX_INVALID");
  }
  const observed = valueAtPointer(
    publicEvidence.sourceEvidence,
    specification.sourceEvidencePointer,
  );
  const artifact = bootstrapDeliveryArtifact({
    campaignId: manifest.campaignId,
    objectiveId: specification.id,
    sourceCommit: manifest.sourceCommit,
    observed,
  });
  const deliveryHash = bootstrapDeliveryHash(artifact);
  const publishedDeliveryHash = specification.expectedDeliveryHash ?? null;
  if (
    publishedDeliveryHash &&
    deliveryHash.toLowerCase() !== publishedDeliveryHash.toLowerCase()
  ) {
    throw new Error("V44_PARTICIPANT_DELIVERY_COMMITMENT_MISMATCH");
  }
  return {
    objectiveIndex,
    specification,
    artifact,
    canonicalArtifact: canonicalJson(artifact),
    deliveryHash,
    publishedDeliveryHash,
    commitmentVerification: publishedDeliveryHash
      ? "PUBLIC_HASH_MATCH"
      : "DERIVED_FROM_PINNED_SOURCE_EVIDENCE",
    capabilityHash: committed.capabilityHash,
  };
}

export function createV44TestnetParticipant({
  env = process.env,
  root = process.cwd(),
  privateKey,
  manifestPath =
    env.AGENTPOOL_V44_TESTNET_MANIFEST ?? env.V44_TESTNET_DEPLOYMENT_MANIFEST,
  rpcUrl = env.AGENTPOOL_V44_TESTNET_RPC_URL ?? "https://sepolia.base.org",
  sourceEvidencePath,
  specificationsPath,
} = {}) {
  if (!manifestPath) throw new Error("V44_PARTICIPANT_MANIFEST_PATH_REQUIRED");
  if (env.AGENTPOOL_CHAIN_ID && Number(env.AGENTPOOL_CHAIN_ID) !== V44_TESTNET_CHAIN_ID) {
    throw new Error("V44_PARTICIPANT_BASE_SEPOLIA_ONLY");
  }
  const { manifest, manifestPath: resolvedManifestPath } =
    parseV44TestnetManifest(manifestPath);
  const publicEvidence = loadV44BootstrapPublicEvidence({
    manifest,
    manifestPath: resolvedManifestPath,
    sourceEvidencePath,
    specificationsPath,
  });
  const abis = {
    token: artifactAbi("AgentPoolV44Token", root),
    ledger: artifactAbi("AgentPoolV43ContributionLedger", root),
    capacity: artifactAbi("AgentPoolV43CapacityRegistry", root),
    market: artifactAbi("AgentPoolV432TaskMarket", root),
    proof: artifactAbi("AgentPoolV432ProofRegistry", root),
    vault: artifactAbi("AgentPoolV43EpochVault", root),
  };
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 3 }),
  });
  const resolvedPrivateKey =
    privateKey ?? readV44PrivateKey({ env, walletPath: defaultV44WalletPath(env) });
  const account = resolvedPrivateKey
    ? privateKeyToAccount(resolvedPrivateKey)
    : null;
  const fees = configuredEip1559Fees(env);

  async function assertChain() {
    const chainId = await client.getChainId();
    if (chainId !== V44_TESTNET_CHAIN_ID) {
      throw new Error(`V44_PARTICIPANT_BASE_SEPOLIA_ONLY:${chainId}`);
    }
  }

  async function read(address, abi, functionName, args = []) {
    await assertChain();
    return client.readContract({ address, abi, functionName, args });
  }

  async function write(address, abi, functionName, args = []) {
    if (!account) throw new Error("V44_PARTICIPANT_LOCAL_WALLET_REQUIRED");
    await assertChain();
    const { request } = await client.simulateContract({
      account,
      address,
      abi,
      functionName,
      args,
    });
    const gas = bufferGasEstimate(await client.estimateContractGas(request));
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout: 30_000, retryCount: 3 }),
    });
    const transactionHash = await wallet.writeContract({
      ...request,
      gas,
      ...fees,
    });
    const receipt = await client.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: 1,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`V44_PARTICIPANT_CHAIN_WRITE_FAILED:${transactionHash}`);
    }
    return {
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  async function status() {
    await assertChain();
    const block = await client.getBlock();
    const genesisStart = BigInt(manifest.genesisStart);
    const profile = account
      ? await read(
          manifest.contracts.contributionLedger,
          abis.ledger,
          "profiles",
          [account.address],
        )
      : null;
    const [totalSupply, coreEmitted, evolutionEmitted, ethBalance, tokenBalance] =
      await Promise.all([
        read(manifest.contracts.token, abis.token, "totalSupply"),
        read(manifest.contracts.coreEpochVault, abis.vault, "totalEmitted"),
        read(manifest.contracts.evolutionEpochVault, abis.vault, "totalEmitted"),
        account ? client.getBalance({ address: account.address }) : 0n,
        account
          ? read(manifest.contracts.token, abis.token, "balanceOf", [account.address])
          : 0n,
      ]);
    return {
      network: "Base Sepolia",
      chainId: V44_TESTNET_CHAIN_ID,
      testnetOnly: true,
      campaignId: manifest.campaignId,
      sourceCommit: manifest.sourceCommit,
      deploymentBlock: manifest.deploymentBlock,
      latestBlock: block.number.toString(),
      latestTimestamp: Number(block.timestamp),
      genesisStart: Number(genesisStart),
      secondsUntilGenesis:
        block.timestamp >= genesisStart ? 0 : Number(genesisStart - block.timestamp),
      walletConfigured: Boolean(account),
      address: account?.address ?? null,
      registered: profile ? Boolean(profile[2]) : false,
      operatorGroup: profile?.[0] ?? null,
      runtimeHash: profile?.[1] ?? null,
      baseSepoliaEth: formatEther(ethBalance),
      tapool: formatUnits(tokenBalance, 18),
      totalSupplyTapool: formatUnits(totalSupply, 18),
      coreEmittedTapool: formatUnits(coreEmitted, 18),
      evolutionEmittedTapool: formatUnits(evolutionEmitted, 18),
    };
  }

  async function opportunities() {
    const fromBlock = BigInt(manifest.deploymentBlock);
    const logs = await client.getContractEvents({
      address: manifest.contracts.taskMarket,
      abi: abis.market,
      eventName: "JobCreated",
      fromBlock,
      toBlock: "latest",
    });
    const jobs = [];
    for (const log of logs) {
      const jobId = log.args.jobId;
      const job = await read(manifest.contracts.taskMarket, abis.market, "jobs", [jobId]);
      const milestones = [];
      for (let index = 0; index < Number(job[9]); index += 1) {
        const milestone = await read(
          manifest.contracts.taskMarket,
          abis.market,
          "milestones",
          [jobId, index],
        );
        if (!account || milestone[0].toLowerCase() === account.address.toLowerCase()) {
          milestones.push({
            index,
            worker: milestone[0],
            capabilityHash: milestone[2],
            specificationHash: milestone[3],
            expectedEvidenceHash: milestone[4],
            allocationTapool: formatUnits(milestone[7], 18),
            keeperFeeTapool: formatUnits(milestone[9], 18),
            deadline: Number(milestone[10]),
            state: Number(milestone[16]),
          });
        }
      }
      if (milestones.length > 0) {
        jobs.push({
          jobId,
          creator: job[0],
          funding: Number(job[1]),
          state: Number(job[2]),
          budgetTapool: formatUnits(job[6], 18),
          paidTapool: formatUnits(job[7], 18),
          milestones,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
        });
      }
    }
    return jobs;
  }

  return {
    manifest,
    manifestPath: resolvedManifestPath,
    publicEvidence,
    abis,
    client,
    account,
    status,
    opportunities,
    read,
    write,
    register: (operatorGroup, runtime) =>
      write(manifest.contracts.contributionLedger, abis.ledger, "register", [
        bytes32(operatorGroup),
        bytes32(runtime),
      ]),
    publishCapacity: (capability, capacity, expiresAt, runtime) =>
      write(manifest.contracts.capacityRegistry, abis.capacity, "publish", [
        HASH.test(capability) ? capability : bytes32(capability),
        capacity,
        expiresAt,
        bytes32(runtime),
      ]),
    accept: (jobId, milestone) =>
      write(manifest.contracts.taskMarket, abis.market, "acceptMilestone", [
        jobId,
        milestone,
      ]),
    deliver: (jobId, milestone, deliveryHash) =>
      write(manifest.contracts.taskMarket, abis.market, "deliver", [
        jobId,
        milestone,
        deliveryHash,
      ]),
    commitEvaluation: ({ jobId, milestone, scoreBps, evidence, salt, proof }) => {
      if (!account) throw new Error("V44_PARTICIPANT_LOCAL_WALLET_REQUIRED");
      const roundId = proofRoundId(jobId, milestone);
      const evidenceHash = bytes32(evidence);
      const saltHash = bytes32(salt);
      const commitment = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "address" },
            { type: "uint16" },
            { type: "bytes32" },
            { type: "bytes32" },
          ],
          [roundId, account.address, scoreBps, evidenceHash, saltHash],
        ),
      );
      return write(
        manifest.contracts.proofRegistry,
        abis.proof,
        "commitWithProof",
        [roundId, commitment, proof],
      );
    },
    revealEvaluation: ({ jobId, milestone, scoreBps, evidence, salt }) =>
      write(manifest.contracts.proofRegistry, abis.proof, "reveal", [
        proofRoundId(jobId, milestone),
        scoreBps,
        bytes32(evidence),
        bytes32(salt),
      ]),
    resolve: ({ jobId, milestone, objectiveProofHex, recipients, amountsApool }) =>
      write(manifest.contracts.taskMarket, abis.market, "resolve", [
        jobId,
        milestone,
        objectiveProofHex,
        recipients,
        amountsApool.map((amount) => parseUnits(String(amount), 18)),
      ]),
    refundExpired: (jobId, milestone) =>
      write(manifest.contracts.taskMarket, abis.market, "refundExpired", [
        jobId,
        milestone,
      ]),
    buildDelivery: (objectiveIndex) =>
      buildV44BootstrapDelivery({ manifest, publicEvidence, objectiveIndex }),
  };
}
