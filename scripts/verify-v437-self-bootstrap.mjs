import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const manifestPath = path.join(root, "deployments", "84532.v43.7.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const rpcUrl = process.env.AGENTPOOL_RPC_URL?.trim();
if (!rpcUrl) throw new Error("AGENTPOOL_RPC_URL_MISSING");
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 60_000, retryCount: 4 }),
});
const artifact = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"),
  );
const poolAbi = artifact("AgentPoolV437SelfBootstrapPool").abi;
const tokenAbi = artifact("AgentPoolV43Token").abi;
const pool = manifest.contracts.selfBootstrapPool;
const read = (functionName, args = []) =>
  client.readContract({ address: pool, abi: poolAbi, functionName, args });
const checks = [];
const check = (name, actual, expected) => {
  const passed =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  checks.push({
    name,
    passed,
    actual: typeof actual === "bigint" ? actual.toString() : actual,
    expected: typeof expected === "bigint" ? expected.toString() : expected,
  });
};
const code = await client.getCode({ address: pool });
check("pool.bytecode", Boolean(code && code !== "0x"), true);
check("pool.codeSize", (code.length - 2) / 2 <= 24_576, true);
check("pool.token", await read("token"), manifest.contracts.token);
check("pool.stageGate", await read("stageGate"), manifest.contracts.stageGate);
check(
  "pool.contributionLedger",
  await read("contributionLedger"),
  manifest.contracts.contributionLedger,
);
check("pool.verifier", await read("verifier"), manifest.contracts.objectiveVerifier);
check("pool.financeInvariant", await read("financeInvariantHash"), manifest.financeInvariantHash);
check("pool.maxItemQuote", await read("maxItemQuote"), parseEther("2"));
check("pool.maxIssueBudget", await read("maxIssueBudget"), parseEther("5"));
check("pool.dailyCap", await read("dailyCap"), parseEther("5"));
check("pool.lifetimeCap", await read("lifetimeCap"), parseEther("10"));
check("pool.maxItemsPerIssue", await read("maxItemsPerIssue"), 8);
check("pool.totalFunded", await read("totalFunded"), parseEther("10"));
check("pool.totalReserved", await read("totalReserved"), 0n);
check("pool.totalPaid", await read("totalPaid"), 0n);
check("pool.graduated", await read("graduated"), false);
check("pool.selfBootstrapOpen", await read("selfBootstrapOpen"), true);
check(
  "pool.tokenBalance",
  await client.readContract({
    address: manifest.contracts.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [pool],
  }),
  parseEther("10"),
);
for (const [index, hash] of manifest.transactionHashes.entries()) {
  const receipt = await client.getTransactionReceipt({ hash });
  check(`transaction:${index + 1}`, receipt.status, "success");
}
const report = {
  ok: checks.every(({ passed }) => passed),
  chainId: 84532,
  version: manifest.version,
  contractCodeHash: keccak256(code),
  checks,
  verifiedAt: new Date().toISOString(),
};
const outputPath = path.join(root, "outputs", "v437-self-bootstrap-verification.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) throw new Error(`V437_VERIFICATION_FAILED:${outputPath}`);
process.stdout.write(
  `${JSON.stringify({ ok: true, checks: checks.length, outputPath })}\n`,
);
