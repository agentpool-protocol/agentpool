import fs from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toHex,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";

const manifest = JSON.parse(
  fs.readFileSync("deployments/84532.v43.4.json", "utf8"),
);
const artifact = (name) =>
  JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
const marketAbi = artifact("AgentPoolV432TaskMarket").abi;
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(
    process.env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org",
    { timeout: 60_000, retryCount: 2 },
  ),
});
const latest = await client.getBlockNumber();
const planHash = keccak256(toBytes("v43-external-job-smoke-plan"));
const logs = await client.getContractEvents({
  address: manifest.contracts.taskMarket,
  abi: marketAbi,
  eventName: "JobCreated",
  fromBlock: latest > 2_000n ? latest - 2_000n : 0n,
  toBlock: "latest",
});
const jobId = logs
  .filter((entry) => entry.args.planHash === planHash)
  .at(-1)?.args.jobId;
if (!jobId) throw new Error("EXTERNAL_SMOKE_JOB_NOT_FOUND");
const recipients = [
  "0xB033F3ffdfa27e9D000A84e0fBc86226e390Ed2e",
  "0x43C4eBA160622834440928d20FC7202a644BAcbd",
];
const data = encodeFunctionData({
  abi: marketAbi,
  functionName: "resolve",
  args: [
    jobId,
    0,
    toHex("agentpool-v43-objective-external-proof"),
    recipients,
    [parseEther("23"), parseEther("3")],
  ],
});
const call = {
  from: "0x50E32856c32cF7c679Be3bab7a43a9823B6aA3a6",
  to: manifest.contracts.taskMarket,
  data,
};
for (const params of [
  [call, "latest", { tracer: "callTracer" }],
  [call, "latest", {}],
]) {
  try {
    const trace = await client.request({
      method: "debug_traceCall",
      params,
    });
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        method: "debug_traceCall",
        message: error.shortMessage ?? error.message,
        details: error.details,
      })}\n`,
    );
  }
}
process.exitCode = 1;
