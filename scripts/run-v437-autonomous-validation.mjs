import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";

const root = process.cwd();
const outputs = path.join(root, "outputs");
const logsDirectory = path.join(outputs, "v437-validation-logs");
const jsonReportPath = path.join(outputs, "v437-autonomous-validation.json");
const markdownReportPath = path.join(root, "V437_VALIDATION_REPORT.md");
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) {
  throw new Error("NPM_CLI_PATH_UNAVAILABLE");
}
const site = "https://agentpool-protocol.asfu.chatgpt.site";
const deployment = JSON.parse(
  fs.readFileSync(path.join(root, "deployments", "84532.v43.7.json"), "utf8"),
);
const poolArtifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV437SelfBootstrapPool.json"),
    "utf8",
  ),
);
const tokenArtifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "artifacts", "AgentPoolV43Token.json"),
    "utf8",
  ),
);

fs.mkdirSync(logsDirectory, { recursive: true });

const results = [];
const fixesApplied = [
  {
    id: "GAS-01",
    problem: "RPC gas estimates could be consumed exactly and revert out of gas",
    fix: "Apply a rounded-up 25 percent gas-limit buffer and fail closed on malformed local EIP-1559 caps",
  },
  {
    id: "RUNNER-01",
    problem: "Windows rejected direct spawnSync execution of npm.cmd",
    fix: "Execute npm-cli.js through the current Node runtime",
  },
  {
    id: "CHAIN-01",
    problem: "Live verification assumed totalReserved must remain zero after deployment",
    fix: "Verify funding, reservation, payout, token-balance, and graduation invariants across in-flight and settled states",
  },
];
const commandChecks = [
  {
    id: "UNIT-01",
    title: "Node unit and integration suite",
    args: ["test"],
    timeout: 240_000,
  },
  {
    id: "LINT-01",
    title: "ESLint",
    args: ["run", "lint"],
    timeout: 180_000,
  },
  {
    id: "SOL-01",
    title: "Solidity compilation",
    args: ["run", "contracts:compile"],
    timeout: 240_000,
  },
  {
    id: "ECON-01",
    title: "v4.3 public economy rehearsal",
    args: ["run", "contracts:rehearse:v4.3:public"],
    timeout: 300_000,
  },
  {
    id: "BOOT-01..05",
    title: "v4.3.7 finite self-bootstrap rehearsal",
    args: ["run", "contracts:rehearse:v4.3.7"],
    timeout: 240_000,
  },
  {
    id: "MCP-01",
    title: "v4.3 MCP self-test",
    args: ["run", "mcp:self-test:v4.3"],
    timeout: 120_000,
  },
  {
    id: "BUILD-01",
    title: "Production build",
    args: ["run", "build"],
    timeout: 300_000,
  },
  {
    id: "CHAIN-01",
    title: "Base Sepolia v4.3.7 read-only verification",
    args: ["run", "contracts:verify:v4.3.7"],
    timeout: 180_000,
  },
  {
    id: "SEC-01",
    title: "Production dependency audit",
    args: ["audit", "--omit=dev", "--audit-level=high", "--json"],
    timeout: 180_000,
  },
];

function safeFileName(value) {
  return value.replaceAll(/[^a-zA-Z0-9.-]+/gu, "-");
}

function recordCommand(check) {
  const started = Date.now();
  const completed = spawnSync(process.execPath, [npmCli, ...check.args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: check.timeout,
    windowsHide: true,
  });
  const combined = [
    `$ node ${npmCli} ${check.args.join(" ")}`,
    completed.stdout ?? "",
    completed.stderr ?? "",
  ].join("\n");
  const evidence = path.join(
    logsDirectory,
    `${safeFileName(check.id)}.log`,
  );
  fs.writeFileSync(evidence, combined);
  const status = completed.status === 0 ? "PASS" : "FAIL";
  results.push({
    id: check.id,
    title: check.title,
    status,
    durationMs: Date.now() - started,
    exitCode: completed.status,
    signal: completed.signal,
    error: completed.error?.message ?? null,
    evidence: path.relative(root, evidence).replaceAll("\\", "/"),
  });
  process.stdout.write(`${status} ${check.id} ${check.title}\n`);
}

async function recordPublicDeployment() {
  const started = Date.now();
  const evidence = path.join(logsDirectory, "WEB-01-02.json");
  try {
    const [homepageResponse, statusResponse, mcpResponse] = await Promise.all([
      fetch(site, { signal: AbortSignal.timeout(30_000) }),
      fetch(`${site}/api/v4.3/status`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      }),
      fetch(`${site}/agentpool-mcp-v437.mjs`, {
        signal: AbortSignal.timeout(30_000),
      }),
    ]);
    const [statusBody, mcpBody] = await Promise.all([
      statusResponse.json(),
      mcpResponse.text(),
    ]);
    const overlay = statusBody.selfBootstrapOverlay;
    const accountingMatches =
      Number(overlay.availableApool) +
        Number(overlay.reservedApool) +
        Number(overlay.paidApool) ===
      Number(overlay.fundedApool);
    const details = {
      homepageStatus: homepageResponse.status,
      statusApiStatus: statusResponse.status,
      mcpStatus: mcpResponse.status,
      release: overlay.release,
      contract: overlay.contract,
      accountingMatches,
      hasV437Tools: mcpBody.includes(
        "agentpool_v437_self_bootstrap_status",
      ),
      hasGasBuffer:
        mcpBody.includes("bufferGasEstimate") ||
        /estimatedGas\s*\*\s*125n/u.test(mcpBody),
      noMainnetChainId: !mcpBody.includes("chainId: 8453,"),
    };
    fs.writeFileSync(evidence, `${JSON.stringify(details, null, 2)}\n`);
    const passed =
      homepageResponse.ok &&
      statusResponse.ok &&
      mcpResponse.ok &&
      overlay.release === deployment.version &&
      overlay.contract.toLowerCase() ===
        deployment.contracts.selfBootstrapPool.toLowerCase() &&
      accountingMatches &&
      details.hasV437Tools &&
      details.hasGasBuffer &&
      details.noMainnetChainId;
    results.push({
      id: "WEB-01..02",
      title: "Public Sites status and downloadable MCP",
      status: passed ? "PASS" : "FAIL",
      durationMs: Date.now() - started,
      evidence: path.relative(root, evidence).replaceAll("\\", "/"),
      details,
    });
  } catch (error) {
    fs.writeFileSync(evidence, `${error.stack ?? error}\n`);
    results.push({
      id: "WEB-01..02",
      title: "Public Sites status and downloadable MCP",
      status: "FAIL",
      durationMs: Date.now() - started,
      evidence: path.relative(root, evidence).replaceAll("\\", "/"),
      error: error.message,
    });
  }
  const latest = results.at(-1);
  process.stdout.write(`${latest.status} ${latest.id} ${latest.title}\n`);
}

async function recordLivePilot() {
  const started = Date.now();
  const evidence = path.join(logsDirectory, "LIVE-01.json");
  try {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(
        process.env.AGENTPOOL_RPC_URL ?? "https://sepolia.base.org",
        { timeout: 30_000, retryCount: 3 },
      ),
    });
    const deployTransaction = await client.getTransaction({
      hash: deployment.transactionHashes[0],
    });
    const pool = deployment.contracts.selfBootstrapPool;
    const [chainId, funded, reserved, paid, tokenBalance, deployerBalance] =
      await Promise.all([
        client.getChainId(),
        client.readContract({
          address: pool,
          abi: poolArtifact.abi,
          functionName: "totalFunded",
        }),
        client.readContract({
          address: pool,
          abi: poolArtifact.abi,
          functionName: "totalReserved",
        }),
        client.readContract({
          address: pool,
          abi: poolArtifact.abi,
          functionName: "totalPaid",
        }),
        client.readContract({
          address: deployment.contracts.token,
          abi: tokenArtifact.abi,
          functionName: "balanceOf",
          args: [pool],
        }),
        client.getBalance({ address: deployTransaction.from }),
      ]);
    const pilotPath = path.join(
      root,
      "deployments",
      "84532.v43.7.self-bootstrap-pilot.json",
    );
    const pilot = fs.existsSync(pilotPath)
      ? JSON.parse(fs.readFileSync(pilotPath, "utf8"))
      : null;
    const accountingMatches = tokenBalance + paid === funded;
    const details = {
      chainId,
      deployer: deployTransaction.from,
      deployerBalanceEth: formatEther(deployerBalance),
      fundedApool: formatUnits(funded, 18),
      reservedApool: formatUnits(reserved, 18),
      paidApool: formatUnits(paid, 18),
      tokenBalanceApool: formatUnits(tokenBalance, 18),
      accountingMatches,
      pilotEvidencePresent: pilot !== null,
      pilotOk: pilot?.ok ?? false,
      blocker:
        pilot === null
          ? "SAFE_2_OF_3_TESTNET_GAS_APPROVAL_REQUIRED"
          : null,
    };
    fs.writeFileSync(evidence, `${JSON.stringify(details, null, 2)}\n`);
    const status =
      !accountingMatches || chainId !== 84532
        ? "FAIL"
        : pilot?.ok
          ? "PASS"
          : "BLOCKED";
    results.push({
      id: "LIVE-01",
      title: "Base Sepolia same-AI 1.5 tAPOOL settlement",
      status,
      durationMs: Date.now() - started,
      evidence: path.relative(root, evidence).replaceAll("\\", "/"),
      details,
    });
  } catch (error) {
    fs.writeFileSync(evidence, `${error.stack ?? error}\n`);
    results.push({
      id: "LIVE-01",
      title: "Base Sepolia same-AI 1.5 tAPOOL settlement",
      status: "FAIL",
      durationMs: Date.now() - started,
      evidence: path.relative(root, evidence).replaceAll("\\", "/"),
      error: error.message,
    });
  }
  const latest = results.at(-1);
  process.stdout.write(`${latest.status} ${latest.id} ${latest.title}\n`);
}

for (const check of commandChecks) recordCommand(check);
await recordPublicDeployment();
await recordLivePilot();

const counts = Object.fromEntries(
  ["PASS", "FAIL", "BLOCKED"].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]),
);
const report = {
  release: deployment.version,
  generatedAt: new Date().toISOString(),
  policy: {
    mainnetUsed: false,
    realAssetsUsed: false,
    blockedIsNotFailure: true,
  },
  counts,
  fixesApplied,
  results,
};
fs.writeFileSync(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);

const markdown = [
  "# AgentPool v4.3.7 Validation Report",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  `Result: **${counts.PASS} PASS / ${counts.FAIL} FAIL / ${counts.BLOCKED} BLOCKED**`,
  "",
  "| ID | Status | Check | Evidence |",
  "|---|---|---|---|",
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.status} | ${result.title} | \`${result.evidence}\` |`,
  ),
  "",
  "## Fixes applied",
  "",
  "| ID | Problem | Fix |",
  "|---|---|---|",
  ...fixesApplied.map(
    (fix) => `| ${fix.id} | ${fix.problem} | ${fix.fix} |`,
  ),
  "",
  "## Interpretation",
  "",
  "- `FAIL` means repository behavior violated an acceptance condition.",
  "- `BLOCKED` means deterministic code checks passed, but an external testnet signature or service is still required.",
  "- Base mainnet and real assets were not used.",
  "",
  "## Remaining external blocker",
  "",
  counts.BLOCKED === 0
    ? "- None."
    : "- `LIVE-01`: the Base Sepolia settlement remains reserved until the existing 2-of-3 Safe supplies test gas. No faucet or real ETH is required.",
  "",
];
fs.writeFileSync(markdownReportPath, `${markdown.join("\n")}\n`);

process.stdout.write(
  `${JSON.stringify({
    ok: counts.FAIL === 0,
    counts,
    jsonReportPath,
    markdownReportPath,
  })}\n`,
);
if (counts.FAIL > 0) process.exitCode = 1;
