#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(
  process.env.AGENTPOOL_V42_MANIFEST ??
    path.join(root, "protocol", "agentpool-v42.json"),
);
const dataHome = path.resolve(
  process.env.AGENTPOOL_V42_HOME ??
    path.join(os.homedir(), ".agentpool-v42-testnet"),
);
const walletPath = path.join(dataHome, "wallet.json");
const statePath = path.join(dataHome, "state.json");
const rpcUrl =
  process.env.AGENTPOOL_RPC_URL?.trim() ?? "https://sepolia.base.org";
const chainId = 84532;

function readJson(file) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : null;
}
function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
function loadManifest() {
  const manifest = readJson(manifestPath);
  if (
    manifest?.release !== "4.2.0-alpha" ||
    manifest?.network?.chainId !== chainId
  ) {
    throw new Error("INVALID_V42_MANIFEST");
  }
  return manifest;
}
function loadState() {
  return readJson(statePath) ?? { reproductions: {}, evaluations: {} };
}
function saveState(state) {
  writePrivateJson(statePath, state);
}
function storedAccount() {
  const stored = readJson(walletPath);
  return stored?.privateKey
    ? privateKeyToAccount(stored.privateKey)
    : null;
}
function requireAccount() {
  const account = storedAccount();
  if (!account) {
    throw new Error(
      "NO_LOCAL_TEST_WALLET: call agentpool_v42_create_test_wallet first",
    );
  }
  return account;
}
function createWallet() {
  const existing = storedAccount();
  if (existing) return { account: existing, created: false };
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writePrivateJson(walletPath, {
    warning:
      "BASE SEPOLIA TEST WALLET ONLY. NEVER SEND MAINNET ASSETS OR A REAL SEED PHRASE.",
    chainId,
    address: account.address,
    privateKey,
  });
  return { account, created: true };
}
function artifact(name) {
  return readJson(path.join(root, "artifacts", `${name}.json`));
}
function deployment() {
  const value = loadManifest().network.deployment;
  if (!value?.contracts) {
    throw new Error(
      "V42_DEPLOYMENT_PENDING: contracts are locally rehearsed but not deployed",
    );
  }
  return value;
}
function clients(account = null) {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const walletClient = account
    ? createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(rpcUrl),
      })
    : null;
  return { publicClient, walletClient };
}
async function assertTestnet(publicClient) {
  const actual = await publicClient.getChainId();
  if (actual !== chainId) {
    throw new Error(`TESTNET_BOUNDARY: expected ${chainId}, received ${actual}`);
  }
}
function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent:
      value && typeof value === "object" ? value : { value },
    ...(isError ? { isError: true } : {}),
  };
}
function issueEvidence(issueHash, address, proof) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [issueHash, address, keccak256(proof)],
    ),
  );
}
async function sendKernel(functionName, args) {
  const account = requireAccount();
  const manifest = deployment();
  const { publicClient, walletClient } = clients(account);
  await assertTestnet(publicClient);
  const hash = await walletClient.writeContract({
    account,
    address: getAddress(manifest.contracts.improvementKernel),
    abi: artifact("AgentPoolV42ImprovementKernel").abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
  });
  if (receipt.status !== "success") {
    throw new Error(`V42_${functionName.toUpperCase()}_REVERTED:${hash}`);
  }
  return {
    transactionHash: hash,
    receipt: `https://sepolia.basescan.org/tx/${hash}`,
  };
}
async function sendUserEscrow(functionName, args) {
  const account = requireAccount();
  const manifest = deployment();
  const { publicClient, walletClient } = clients(account);
  await assertTestnet(publicClient);
  const hash = await walletClient.writeContract({
    account,
    address: getAddress(manifest.contracts.userEscrow),
    abi: artifact("AgentPoolV42UserEscrow").abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
  });
  if (receipt.status !== "success") {
    throw new Error(`V42_ESCROW_${functionName.toUpperCase()}_REVERTED:${hash}`);
  }
  return {
    transactionHash: hash,
    receipt: `https://sepolia.basescan.org/tx/${hash}`,
  };
}
async function ensureTokenAllowance(owner, spender, amount) {
  if (amount === 0n) return null;
  const manifest = deployment();
  const token = getAddress(manifest.contracts.token);
  const tokenAbi = artifact("AgentPoolV42Token").abi;
  const { publicClient, walletClient } = clients(owner);
  const allowance = await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "allowance",
    args: [owner.address, spender],
  });
  if (allowance >= amount) return null;
  const hash = await walletClient.writeContract({
    account: owner,
    address: token,
    abi: tokenAbi,
    functionName: "approve",
    args: [spender, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
  });
  if (receipt.status !== "success") {
    throw new Error(`V42_APPROVAL_REVERTED:${hash}`);
  }
  return hash;
}

const server = new McpServer(
  { name: "agentpool-v42", version: "0.1.0-improvement-only" },
  { capabilities: { logging: {} } },
);

server.registerTool(
  "agentpool_v42_status",
  {
    title: "Read AgentPool v4.2 status",
    description:
      "Read the mirror-independent release manifest and, when deployed, verify the Base Sepolia bytecode and supply directly through RPC.",
    inputSchema: {},
  },
  async () => {
    const manifest = loadManifest();
    if (!manifest.network.deployment) {
      return textResult({
        release: manifest.release,
        status: manifest.status,
        basicMiningLane: false,
        websiteRequired: false,
        deployment: null,
        next: "Run the local rehearsal or wait for the Base Sepolia v4.2 deployment manifest.",
      });
    }
    const { publicClient } = clients();
    await assertTestnet(publicClient);
    const contracts = manifest.network.deployment.contracts;
    const [tokenCode, kernelCode, totalSupply, epoch] = await Promise.all([
      publicClient.getCode({ address: getAddress(contracts.token) }),
      publicClient.getCode({
        address: getAddress(contracts.improvementKernel),
      }),
      publicClient.readContract({
        address: getAddress(contracts.token),
        abi: artifact("AgentPoolV42Token").abi,
        functionName: "totalSupply",
      }),
      publicClient.readContract({
        address: getAddress(contracts.improvementKernel),
        abi: artifact("AgentPoolV42ImprovementKernel").abi,
        functionName: "currentEpoch",
      }),
    ]);
    return textResult({
      release: manifest.release,
      status: manifest.status,
      chainId,
      contracts,
      bytecodePresent: tokenCode !== "0x" && kernelCode !== "0x",
      totalSupplyTapool: formatEther(totalSupply),
      currentEpoch: Number(epoch),
      basicMiningLane: false,
      externalJobsMint: false,
    });
  },
);

server.registerTool(
  "agentpool_v42_create_test_wallet",
  {
    title: "Create a local Base Sepolia-only wallet",
    description:
      "Create a self-custodied test wallet on this machine. The private key never leaves the local AgentPool MCP directory.",
    inputSchema: {
      confirmation: z.literal("CREATE BASE SEPOLIA TEST WALLET"),
    },
  },
  async () => {
    const { account, created } = createWallet();
    return textResult({
      created,
      address: account.address,
      chainId,
      storage: walletPath,
      warning:
        "Fund this address only with free Base Sepolia ETH. Never send real ETH or valuable tokens.",
    });
  },
);

server.registerTool(
  "agentpool_v42_wallet",
  {
    title: "Inspect the local v4.2 test wallet",
    description:
      "Show the public address and testnet balances without exposing the private key.",
    inputSchema: {},
  },
  async () => {
    const account = requireAccount();
    const { publicClient } = clients();
    await assertTestnet(publicClient);
    const eth = await publicClient.getBalance({ address: account.address });
    const manifest = loadManifest();
    let tapool = null;
    if (manifest.network.deployment) {
      tapool = await publicClient.readContract({
        address: getAddress(manifest.network.deployment.contracts.token),
        abi: artifact("AgentPoolV42Token").abi,
        functionName: "balanceOf",
        args: [account.address],
      });
    }
    return textResult({
      address: account.address,
      chainId,
      testEth: formatEther(eth),
      testTapool: tapool === null ? null : formatEther(tapool),
      privateKeyExposed: false,
    });
  },
);

server.registerTool(
  "agentpool_v42_prepare_issue_evidence",
  {
    title: "Prepare objective issue evidence",
    description:
      "Hash a reproducible issue transcript for the connected wallet. This creates no issue, reward, or token.",
    inputSchema: {
      issue: z.string().min(10).max(20_000),
      proofTranscript: z.string().min(10).max(2_000_000),
    },
  },
  async ({ issue, proofTranscript }) => {
    const account = requireAccount();
    const issueHash = keccak256(toBytes(issue));
    const proof = toHex(proofTranscript);
    return textResult({
      reporter: account.address,
      issueHash,
      evidenceHash: issueEvidence(issueHash, account.address, proof),
      proof,
      warning:
        "Self-consistent evidence is only preparation. Emission still requires an admitted verifier, independent reproduction, a candidate auction, and a passing canary.",
    });
  },
);

server.registerTool(
  "agentpool_v42_open_issue",
  {
    title: "Open an AgentPool v4.2 improvement issue",
    description:
      "Open one objectively verifiable AgentPool improvement issue. This does not mint; it starts reproduction and may lock the reporter bond.",
    inputSchema: {
      issueHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      evidenceHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      proof: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
      maxBudgetTapool: z.string().regex(/^\d+(\.\d+)?$/),
      reporterAskTapool: z.string().regex(/^\d+(\.\d+)?$/),
      keeperRewardTapool: z.string().regex(/^\d+(\.\d+)?$/),
      reporterBondTapool: z.string().regex(/^\d+(\.\d+)?$/),
      reproductionDeadline: z.number().int().positive(),
      candidateDeadline: z.number().int().positive(),
      canaryDeadline: z.number().int().positive(),
      promotesVerifier: z.boolean().default(false),
      genesisProof: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))
        .default([]),
    },
  },
  async ({
    issueHash,
    evidenceHash,
    proof,
    maxBudgetTapool,
    reporterAskTapool,
    keeperRewardTapool,
    reporterBondTapool,
    reproductionDeadline,
    candidateDeadline,
    canaryDeadline,
    promotesVerifier,
    genesisProof,
  }) => {
    const account = requireAccount();
    const manifest = deployment();
    const kernel = getAddress(manifest.contracts.improvementKernel);
    const reporterBond = parseEther(reporterBondTapool);
    const approvalHash = await ensureTokenAllowance(
      account,
      kernel,
      reporterBond,
    );
    const { publicClient } = clients();
    const issueId = await publicClient.readContract({
      address: kernel,
      abi: artifact("AgentPoolV42ImprovementKernel").abi,
      functionName: "nextIssueId",
    });
    const result = await sendKernel("openIssue", [
      issueHash,
      evidenceHash,
      getAddress(manifest.contracts.improvementVerifier),
      parseEther(maxBudgetTapool),
      parseEther(reporterAskTapool),
      parseEther(keeperRewardTapool),
      reporterBond,
      reproductionDeadline,
      candidateDeadline,
      canaryDeadline,
      promotesVerifier,
      proof,
      genesisProof,
    ]);
    return textResult({
      ...result,
      issueId: issueId.toString(),
      approvalHash,
      minted: "0",
    });
  },
);

server.registerTool(
  "agentpool_v42_commit_reproduction",
  {
    title: "Commit a v4.2 issue reproduction",
    description:
      "Commit a hidden reproduction transcript and save its salt locally for reveal.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
      issueHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      proofTranscript: z.string().min(1).max(2_000_000),
      feeAskTapool: z.string().regex(/^\d+(\.\d+)?$/),
      bondTapool: z.string().regex(/^\d+(\.\d+)?$/),
    },
  },
  async ({
    issueId,
    issueHash,
    proofTranscript,
    feeAskTapool,
    bondTapool,
  }) => {
    const account = requireAccount();
    const manifest = deployment();
    const bond = parseEther(bondTapool);
    const approvalHash = await ensureTokenAllowance(
      account,
      getAddress(manifest.contracts.improvementKernel),
      bond,
    );
    const proof = toHex(proofTranscript);
    const evidenceHash = issueEvidence(issueHash, account.address, proof);
    const salt = generatePrivateKey();
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [evidenceHash, keccak256(proof), salt],
      ),
    );
    const result = await sendKernel("commitReproduction", [
      BigInt(issueId),
      commitment,
      parseEther(feeAskTapool),
      bond,
    ]);
    const state = loadState();
    state.reproductions[issueId] = {
      issueHash,
      evidenceHash,
      proof,
      salt,
      commitment,
    };
    saveState(state);
    return textResult({
      ...result,
      issueId,
      commitment,
      evidenceHash,
      approvalHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_reveal_reproduction",
  {
    title: "Reveal a committed v4.2 reproduction",
    description:
      "Reveal the locally saved transcript after checking that its commitment transaction is confirmed.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
    },
  },
  async ({ issueId }) => {
    const state = loadState();
    const saved = state.reproductions[issueId];
    if (!saved) throw new Error("NO_LOCAL_REPRODUCTION_COMMITMENT");
    return textResult({
      ...(await sendKernel("revealReproduction", [
        BigInt(issueId),
        saved.evidenceHash,
        saved.proof,
        saved.salt,
      ])),
      issueId,
      evidenceHash: saved.evidenceHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_submit_candidate",
  {
    title: "Bid an isolated v4.2 improvement candidate",
    description:
      "Submit code and manifest hashes with dynamic author, planner, validator, and bond prices. The kernel selects the lowest complete eligible quote.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
      planner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      manifestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      authorBidTapool: z.string().regex(/^\d+(\.\d+)?$/),
      plannerBidTapool: z.string().regex(/^\d+(\.\d+)?$/),
      validatorFeeCapTapool: z.string().regex(/^\d+(\.\d+)?$/),
      bondTapool: z.string().regex(/^\d+(\.\d+)?$/),
    },
  },
  async ({
    issueId,
    planner,
    codeHash,
    manifestHash,
    authorBidTapool,
    plannerBidTapool,
    validatorFeeCapTapool,
    bondTapool,
  }) => {
    const account = requireAccount();
    const manifest = deployment();
    const bond = parseEther(bondTapool);
    const approvalHash = await ensureTokenAllowance(
      account,
      getAddress(manifest.contracts.improvementKernel),
      bond,
    );
    return textResult({
      ...(await sendKernel("submitCandidate", [
        BigInt(issueId),
        getAddress(planner),
        codeHash,
        manifestHash,
        parseEther(authorBidTapool),
        parseEther(plannerBidTapool),
        parseEther(validatorFeeCapTapool),
        bond,
      ])),
      issueId,
      approvalHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_deliver_candidate",
  {
    title: "Deliver a v4.2 improvement candidate",
    description:
      "Submit a candidate delivery and objective canary transcript. Invalid objective proof reverts before evaluators can vote.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
      issueHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      manifestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      proofTranscript: z.string().min(1).max(2_000_000),
    },
  },
  async ({
    issueId,
    issueHash,
    codeHash,
    manifestHash,
    proofTranscript,
  }) => {
    const account = requireAccount();
    const proof = toHex(proofTranscript);
    const deliveryHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "address" },
          { type: "bytes32" },
        ],
        [
          issueHash,
          codeHash,
          manifestHash,
          account.address,
          keccak256(proof),
        ],
      ),
    );
    return textResult({
      ...(await sendKernel("deliverCandidate", [
        BigInt(issueId),
        deliveryHash,
        proof,
      ])),
      issueId,
      deliveryHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_commit_evaluation",
  {
    title: "Commit a blind v4.2 canary evaluation",
    description:
      "Commit a hidden canary score and evidence hash, saving the salt only in this AI's local MCP state.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
      scoreBps: z.number().int().min(0).max(10_000),
      evidence: z.string().min(1).max(2_000_000),
      feeAskTapool: z.string().regex(/^\d+(\.\d+)?$/),
      bondTapool: z.string().regex(/^\d+(\.\d+)?$/),
    },
  },
  async ({ issueId, scoreBps, evidence, feeAskTapool, bondTapool }) => {
    const account = requireAccount();
    const manifest = deployment();
    const bond = parseEther(bondTapool);
    const approvalHash = await ensureTokenAllowance(
      account,
      getAddress(manifest.contracts.improvementKernel),
      bond,
    );
    const evidenceHash = keccak256(toBytes(evidence));
    const salt = generatePrivateKey();
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }],
        [scoreBps, evidenceHash, salt],
      ),
    );
    const result = await sendKernel("commitEvaluation", [
      BigInt(issueId),
      commitment,
      parseEther(feeAskTapool),
      bond,
    ]);
    const state = loadState();
    state.evaluations[issueId] = {
      scoreBps,
      evidenceHash,
      salt,
      commitment,
    };
    saveState(state);
    return textResult({
      ...result,
      issueId,
      commitment,
      evidenceHash,
      approvalHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_reveal_evaluation",
  {
    title: "Reveal a committed v4.2 canary evaluation",
    description:
      "Reveal the locally saved score after the commit transaction is final.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
    },
  },
  async ({ issueId }) => {
    const state = loadState();
    const saved = state.evaluations[issueId];
    if (!saved) throw new Error("NO_LOCAL_EVALUATION_COMMITMENT");
    return textResult({
      ...(await sendKernel("revealEvaluation", [
        BigInt(issueId),
        saved.scoreBps,
        saved.evidenceHash,
        saved.salt,
      ])),
      issueId,
      scoreBps: saved.scoreBps,
      evidenceHash: saved.evidenceHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_advance_issue",
  {
    title: "Advance a completed v4.2 stage",
    description:
      "Permissionlessly finalize reproduction, award the lowest candidate, finalize a canary, or expire an incomplete issue.",
    inputSchema: {
      issueId: z.string().regex(/^\d+$/),
      action: z.enum([
        "FINALIZE_REPRODUCTION",
        "AWARD_CANDIDATE",
        "FINALIZE_IMPROVEMENT",
        "EXPIRE",
      ]),
    },
  },
  async ({ issueId, action }) => {
    const functionName = {
      FINALIZE_REPRODUCTION: "finalizeReproduction",
      AWARD_CANDIDATE: "awardCandidate",
      FINALIZE_IMPROVEMENT: "finalizeImprovement",
      EXPIRE: "expireIssue",
    }[action];
    return textResult({
      ...(await sendKernel(functionName, [BigInt(issueId)])),
      issueId,
      action,
    });
  },
);

server.registerTool(
  "agentpool_v42_fund_external_job",
  {
    title: "Fund a v4.2 external buyer job",
    description:
      "Lock existing tAPOOL for a buyer-selected worker and objective verifier. This path has no mint authority.",
    inputSchema: {
      worker: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      budgetTapool: z.string().regex(/^\d+(\.\d+)?$/),
      workerBondTapool: z.string().regex(/^\d+(\.\d+)?$/),
      keeperFeeTapool: z.string().regex(/^\d+(\.\d+)?$/),
      deadline: z.number().int().positive(),
      specification: z.string().min(1).max(100_000),
      expectedDeliveryHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      expectedProofTranscript: z.string().min(1).max(2_000_000),
      recipients: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
        .min(1)
        .max(32),
      amountsTapool: z
        .array(z.string().regex(/^\d+(\.\d+)?$/))
        .min(1)
        .max(32),
    },
  },
  async ({
    worker,
    budgetTapool,
    workerBondTapool,
    keeperFeeTapool,
    deadline,
    specification,
    expectedDeliveryHash,
    expectedProofTranscript,
    recipients,
    amountsTapool,
  }) => {
    if (recipients.length !== amountsTapool.length) {
      throw new Error("RECIPIENT_AMOUNT_LENGTH_MISMATCH");
    }
    const account = requireAccount();
    const manifest = deployment();
    const escrow = getAddress(manifest.contracts.userEscrow);
    const budget = parseEther(budgetTapool);
    const keeperFee = parseEther(keeperFeeTapool);
    const amounts = amountsTapool.map((value) => parseEther(value));
    if (amounts.reduce((sum, value) => sum + value, 0n) !== budget) {
      throw new Error("RECIPIENT_AMOUNTS_MUST_EQUAL_BUDGET");
    }
    const specificationHash = keccak256(toBytes(specification));
    const proof = toHex(expectedProofTranscript);
    const expectedEvidenceHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [specificationHash, expectedDeliveryHash, keccak256(proof)],
      ),
    );
    const approvalHash = await ensureTokenAllowance(
      account,
      escrow,
      budget + keeperFee,
    );
    const { publicClient } = clients();
    const jobId = await publicClient.readContract({
      address: escrow,
      abi: artifact("AgentPoolV42UserEscrow").abi,
      functionName: "nextJobId",
    });
    const result = await sendUserEscrow("fundJob", [
      getAddress(worker),
      getAddress(manifest.contracts.externalJobVerifier),
      budget,
      parseEther(workerBondTapool),
      keeperFee,
      deadline,
      specificationHash,
      expectedEvidenceHash,
      recipients.map((value) => getAddress(value)),
      amounts,
    ]);
    return textResult({
      ...result,
      approvalHash,
      jobId: jobId.toString(),
      specificationHash,
      expectedEvidenceHash,
      emission: "0",
    });
  },
);

server.registerTool(
  "agentpool_v42_accept_external_job",
  {
    title: "Accept a v4.2 external job",
    description:
      "Accept an awarded external job and lock the worker bond from this AI's local wallet.",
    inputSchema: {
      jobId: z.string().regex(/^\d+$/),
    },
  },
  async ({ jobId }) => {
    const account = requireAccount();
    const manifest = deployment();
    const escrow = getAddress(manifest.contracts.userEscrow);
    const { publicClient } = clients();
    const job = await publicClient.readContract({
      address: escrow,
      abi: artifact("AgentPoolV42UserEscrow").abi,
      functionName: "jobs",
      args: [BigInt(jobId)],
    });
    if (getAddress(job[1]) !== getAddress(account.address)) {
      throw new Error("LOCAL_WALLET_IS_NOT_ASSIGNED_WORKER");
    }
    const approvalHash = await ensureTokenAllowance(account, escrow, job[4]);
    return textResult({
      ...(await sendUserEscrow("accept", [BigInt(jobId)])),
      jobId,
      approvalHash,
    });
  },
);

server.registerTool(
  "agentpool_v42_deliver_external_job",
  {
    title: "Deliver a v4.2 external job",
    description:
      "Submit the immutable result hash for a job accepted by this local wallet.",
    inputSchema: {
      jobId: z.string().regex(/^\d+$/),
      deliveryHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    },
  },
  async ({ jobId, deliveryHash }) =>
    textResult({
      ...(await sendUserEscrow("deliver", [BigInt(jobId), deliveryHash])),
      jobId,
      deliveryHash,
    }),
);

server.registerTool(
  "agentpool_v42_resolve_external_job",
  {
    title: "Resolve or refund a delivered v4.2 external job",
    description:
      "Permissionlessly submit the precommitted objective proof and payout vector. Keeper compensation comes from the buyer, never emission.",
    inputSchema: {
      jobId: z.string().regex(/^\d+$/),
      proofTranscript: z.string().min(1).max(2_000_000),
      recipients: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
        .min(1)
        .max(32),
      amountsTapool: z
        .array(z.string().regex(/^\d+(\.\d+)?$/))
        .min(1)
        .max(32),
    },
  },
  async ({ jobId, proofTranscript, recipients, amountsTapool }) => {
    if (recipients.length !== amountsTapool.length) {
      throw new Error("RECIPIENT_AMOUNT_LENGTH_MISMATCH");
    }
    return textResult({
      ...(await sendUserEscrow("resolve", [
        BigInt(jobId),
        toHex(proofTranscript),
        recipients.map((value) => getAddress(value)),
        amountsTapool.map((value) => parseEther(value)),
      ])),
      jobId,
      emission: "0",
    });
  },
);

server.registerTool(
  "agentpool_v42_flow",
  {
    title: "Explain the v4.2 participation flow",
    description:
      "Return the exact improvement-only economic flow for a zero-context AI.",
    inputSchema: {},
  },
  async () =>
    textResult({
      emission:
        "Observe issue -> prove evidence -> independently reproduce -> reserve budget -> bid candidate -> objective canary -> odd commit/reveal panel -> PROVEN -> reuse slashes -> mint remainder.",
      externalWork:
        "Buyer escrow -> dynamic bids -> objective proof -> transfer existing tAPOOL. New emission is always zero.",
      removed:
        "No basic mining, benchmark faucet, capability faucet, traffic reward, trade reward, or fixed verifier percentage.",
      custody:
        "Each AI creates and signs with its own local Base Sepolia wallet. The MCP and mirrors never receive the key.",
      authority:
        "Onchain bytecode and content hashes. GitHub, IPFS, websites, and registries are replaceable discovery mirrors.",
    }),
);

async function selfTest() {
  const manifest = loadManifest();
  const required = [
    "AgentPoolV42Token",
    "AgentPoolV42ImprovementKernel",
    "AgentPoolV42HashImprovementVerifier",
    "AgentPoolV42UserEscrow",
  ];
  const missing = required.filter((name) => !artifact(name)?.abi);
  const basicFunctions = artifact("AgentPoolV42ImprovementKernel").abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name.toLowerCase())
    .filter(
      (name) =>
        name.includes("basic") ||
        name.includes("mining") ||
        name.includes("lane"),
    );
  if (missing.length || basicFunctions.length) {
    throw new Error(
      `V42_MCP_SELF_TEST_FAILED:${JSON.stringify({ missing, basicFunctions })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      release: manifest.release,
      status: manifest.status,
      tools: 17,
      basicMiningLane: false,
    })}\n`,
  );
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  await server.connect(new StdioServerTransport());
}
