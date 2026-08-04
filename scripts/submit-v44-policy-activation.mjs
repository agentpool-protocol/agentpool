import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  artifact,
  readJson,
} from "./lib/v44-mainnet.mjs";
import { loadLedgerContext, writeJsonAtomic } from "./lib/v44-observation-ledger.mjs";
import {
  validatePolicyActivationPackage,
  validatePolicyActivationSignatures,
} from "./lib/v44-policy-activation-workflow.mjs";

function argumentsFor(name) {
  const prefix = `--${name}=`;
  return process.argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

function argument(name) {
  return argumentsFor(name)[0] ?? null;
}

export async function submitPolicyActivation({
  context = loadLedgerContext(),
  activationPackage,
  signatures,
  rpcUrl,
  relayerPrivateKey,
  receiptPath,
  publicClient = null,
  walletClient = null,
}) {
  if (!rpcUrl) throw new Error("V44_POLICY_ACTIVATION_RPC_MISSING");
  if (!/^0x[0-9a-fA-F]{64}$/u.test(relayerPrivateKey ?? "")) {
    throw new Error("V44_POLICY_ACTIVATION_RELAYER_KEY_INVALID");
  }
  validatePolicyActivationPackage(activationPackage, context.deployment);
  const accepted = await validatePolicyActivationSignatures({
    request: activationPackage.request,
    signatures,
  });
  const account = privateKeyToAccount(relayerPrivateKey);
  const transport = http(rpcUrl, { timeout: 60_000, retryCount: 3 });
  const reader =
    publicClient ?? createPublicClient({ chain: baseSepolia, transport });
  const writer =
    walletClient ??
    createWalletClient({ chain: baseSepolia, transport, account });
  if ((await reader.getChainId()) !== 84532) {
    throw new Error("V44_POLICY_ACTIVATION_CHAIN_MISMATCH");
  }
  const authorityAbi = artifact("AgentPoolV44ThresholdAuthority").abi;
  const anchorAbi = artifact("AgentPoolV44PolicyAnchor").abi;
  const [nonce, activeAnchorHash, block] = await Promise.all([
    reader.readContract({
      address: context.deployment.contracts.thresholdAuthority,
      abi: authorityAbi,
      functionName: "nonce",
    }),
    reader.readContract({
      address: context.deployment.contracts.policyAnchor,
      abi: anchorAbi,
      functionName: "activeAnchorHash",
    }),
    reader.getBlock({ blockTag: "latest" }),
  ]);
  if (
    nonce.toString() !== activationPackage.request.operationNonce ||
    activeAnchorHash !== `0x${"00".repeat(32)}` ||
    Number(block.timestamp) > activationPackage.request.deadline
  ) {
    throw new Error("V44_POLICY_ACTIVATION_REQUEST_STALE");
  }
  const anchor = activationPackage.autonomyPolicy.policyActivation.anchorHistory[0];
  const args = [
    context.deployment.contracts.policyAnchor,
    BigInt(anchor.activationSequence),
    `0x${anchor.policyConfigurationHash}`,
    `0x${anchor.signerSetHash}`,
    `0x${anchor.activationSignerSetHash}`,
    anchor.activationThreshold,
    `0x${anchor.activationBindingsRoot}`,
    `0x${anchor.evidencePipelineCommit}`,
    anchor.previousAnchorHash,
    anchor.transparencyLogRoot,
    BigInt(activationPackage.request.operationNonce),
    BigInt(activationPackage.request.deadline),
    accepted.map((entry) => entry.signature),
  ];
  const simulation = await reader.simulateContract({
    account,
    address: context.deployment.contracts.thresholdAuthority,
    abi: authorityAbi,
    functionName: "executePolicyActivation",
    args,
  });
  const transactionHash = await writer.writeContract(simulation.request);
  if (!isHex(transactionHash, { strict: true })) {
    throw new Error("V44_POLICY_ACTIVATION_TRANSACTION_INVALID");
  }
  const receipt = await reader.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
    timeout: 120_000,
  });
  if (receipt.status !== "success") {
    throw new Error("V44_POLICY_ACTIVATION_TRANSACTION_REVERTED");
  }
  const output = {
    schema: "agentpool.testnet.v44.policy-activation-receipt/v1",
    campaignId: context.deployment.campaignId,
    packageSha256: activationPackage.packageSha256,
    requestSha256: activationPackage.request.requestSha256,
    transactionHash,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    relayer: account.address.toLowerCase(),
    signers: accepted.map((entry) => entry.signer),
    finalized: false,
  };
  writeJsonAtomic(receiptPath, output);
  return { ok: true, ...output, receiptPath };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  if (
    process.env.V44_TESTNET_ONLY_ACK !==
    "I_UNDERSTAND_THIS_IS_VALUELESS_BASE_SEPOLIA"
  ) {
    throw new Error("V44_TESTNET_ONLY_ACK_REQUIRED");
  }
  const packageValue = argument("package");
  const signatureValues = argumentsFor("signature");
  if (!packageValue || signatureValues.length === 0) {
    throw new Error("V44_POLICY_ACTIVATION_INPUTS_MISSING");
  }
  const context = loadLedgerContext();
  const activationPackage = readJson(path.resolve(packageValue));
  const signatures = signatureValues.map((value) =>
    readJson(path.resolve(value)),
  );
  const receiptPath = path.resolve(
    argument("output") ??
      path.join(
        path.dirname(path.resolve(packageValue)),
        `v44-policy-activation-receipt.${context.deployment.campaignId}.local.json`,
      ),
  );
  const result = await submitPolicyActivation({
    context,
    activationPackage,
    signatures,
    rpcUrl:
      process.env.AGENTPOOL_V44_TESTNET_RPC_URL ??
      process.env.V44_TESTNET_RPC_URL,
    relayerPrivateKey: process.env.V44_TESTNET_RELAYER_PRIVATE_KEY,
    receiptPath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
