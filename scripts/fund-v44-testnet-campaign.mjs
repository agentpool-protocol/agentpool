import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  V44_TESTNET_CHAIN_ID,
  parseV44TestnetManifest,
} from "./lib/v44-testnet-participant.mjs";
import { bufferGasEstimate, configuredEip1559Fees } from "../lib/evm-gas.mjs";

if (process.argv.includes("--mainnet") || Number(process.env.AGENTPOOL_CHAIN_ID ?? 84532) !== 84532) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_BASE_SEPOLIA_ONLY");
}
const manifestPath =
  process.env.AGENTPOOL_V44_TESTNET_MANIFEST ??
  process.env.V44_TESTNET_DEPLOYMENT_MANIFEST;
if (!manifestPath) throw new Error("V44_TESTNET_GAS_SPONSOR_MANIFEST_REQUIRED");
const { manifest } = parseV44TestnetManifest(manifestPath);
const worker = process.env.V44_BOOTSTRAP_WORKER?.trim();
if (!/^0x[a-fA-F0-9]{40}$/u.test(worker ?? "")) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_WORKER_INVALID");
}
const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!/^0x[a-fA-F0-9]{64}$/u.test(privateKey ?? "")) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_DEPLOYER_KEY_REQUIRED");
}
const account = privateKeyToAccount(privateKey);
if (account.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_DEPLOYER_MISMATCH");
}
const target = parseEther(process.env.V44_TESTNET_GAS_TARGET_ETH ?? "0.00003");
const maximumTarget = parseEther("0.00005");
const minimumSponsorRemainder = parseEther("0.0005");
if (target <= 0n || target > maximumTarget) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_TARGET_INVALID");
}
const recipients = [
  manifest.bootstrap.issue.bootstrapProposer,
  ...manifest.bootstrap.validators.map((validator) => validator.address),
  worker,
].filter(
  (address, index, values) =>
    values.findIndex((candidate) => candidate.toLowerCase() === address.toLowerCase()) ===
    index,
);
const rpcUrl =
  process.env.AGENTPOOL_V44_TESTNET_RPC_URL ?? "https://sepolia.base.org";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 3 }),
});
if ((await client.getChainId()) !== V44_TESTNET_CHAIN_ID) {
  throw new Error("V44_TESTNET_GAS_SPONSOR_BASE_SEPOLIA_ONLY");
}
const balances = await Promise.all(
  recipients.map((address) => client.getBalance({ address })),
);
const deficits = balances.map((balance) => (balance >= target ? 0n : target - balance));
const required = deficits.reduce((total, deficit) => total + deficit, 0n);
const sponsorBalance = await client.getBalance({ address: account.address });
if (sponsorBalance - required < minimumSponsorRemainder) {
  throw new Error(
    `V44_TESTNET_GAS_SPONSOR_RESERVE_TOO_LOW:${formatEther(sponsorBalance)}:${formatEther(required)}`,
  );
}
const wallet = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 3 }),
});
const fees = configuredEip1559Fees(process.env);
const grants = [];
for (let index = 0; index < recipients.length; index += 1) {
  if (deficits[index] === 0n) {
    grants.push({
      recipient: recipients[index],
      beforeEth: formatEther(balances[index]),
      sentEth: "0",
      status: "ALREADY_FUNDED",
    });
    continue;
  }
  const request = {
    account,
    to: recipients[index],
    value: deficits[index],
    ...fees,
  };
  const gas = bufferGasEstimate(await client.estimateGas(request));
  const transactionHash = await wallet.sendTransaction({ ...request, gas });
  const receipt = await client.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`V44_TESTNET_GAS_SPONSOR_TRANSFER_FAILED:${transactionHash}`);
  }
  grants.push({
    recipient: recipients[index],
    beforeEth: formatEther(balances[index]),
    sentEth: formatEther(deficits[index]),
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    status: "CONFIRMED",
  });
}
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      network: "Base Sepolia",
      chainId: V44_TESTNET_CHAIN_ID,
      testnetOnly: true,
      campaignId: manifest.campaignId,
      sponsor: account.address,
      targetEth: formatEther(target),
      grants,
      sponsorRemainingEth: formatEther(
        await client.getBalance({ address: account.address }),
      ),
    },
    null,
    2,
  )}\n`,
);
