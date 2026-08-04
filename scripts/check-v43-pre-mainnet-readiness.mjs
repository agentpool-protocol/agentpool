import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveProviderLaunch } from "../runner/execution-adapters.mjs";

const execFileAsync = promisify(execFile);
const origin =
  process.env.AGENTPOOL_V43_RELAY_URL ??
  "https://agentpool-protocol.asfu.chatgpt.site";

async function json(pathname) {
  const response = await fetch(new URL(pathname, origin), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}:${pathname}`);
  }
  return response.json();
}

async function codexStatus() {
  const launch = resolveProviderLaunch("codex");
  try {
    const result = await execFileAsync(
      launch.command,
      [...launch.prefixArgs, "login", "status"],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      },
    );
    return {
      available: true,
      authenticated: /logged in/i.test(
        `${result.stdout}\n${result.stderr}`,
      ),
      source: launch.source,
    };
  } catch (error) {
    return {
      available: false,
      authenticated: false,
      source: launch.source,
      error:
        error instanceof Error
          ? error.message.split("\n")[0]
          : String(error),
    };
  }
}

const [status, runners, codex, evidence] = await Promise.all([
  json("/api/v4.3/status"),
  json("/api/v4.3/runners"),
  codexStatus(),
  readFile(
    new URL(
      "../deployments/84532.v43.6.codex-e2e.json",
      import.meta.url,
    ),
    "utf8",
  ).then(JSON.parse),
]);

const checks = {
  baseSepoliaOnly:
    status.chainId === 84532 &&
    status.baseSepoliaDeployment?.manifest ===
      "deployments/84532.v43.5.json",
  onchainSettlementLive: status.onchainSettlement === true,
  codexAvailable: codex.available === true,
  codexAuthenticated: codex.authenticated === true,
  realCodexSettlement:
    evidence.ok === true &&
    evidence.actualExecutor === "codex" &&
    evidence.workerPaidApool === "2" &&
    evidence.validatorAndKeeperPaidApool === "1",
  externalJobEmissionZero:
    evidence.externalJobEmissionApool === "0" &&
    evidence.totalSupplyBeforeApool ===
      evidence.totalSupplyAfterApool,
  noPrivateKeyEvidence:
    evidence.privateKeysStoredOrExposed === false,
  signedRunnerObserved: Number(runners.activeCount) > 0,
};

const codingReady = Object.values(checks).every(Boolean);
const independentGroups = new Set(
  (runners.runners ?? [])
    .filter((runner) => runner.status === "ACTIVE")
    .map((runner) => runner.operatorGroup)
    .filter(Boolean),
);
const report = {
  ok: codingReady,
  scope: "PRE_MAINNET_PUBLIC_TESTNET",
  generatedAt: new Date().toISOString(),
  release: status.release,
  chainId: status.chainId,
  codex,
  activeRunners: runners.activeCount,
  observedIndependentGroupClaims: independentGroups.size,
  checks,
  maturity: {
    currentPhase: status.chain?.phase ?? "UNKNOWN",
    naturallyMature:
      status.chain?.phase === "MATURE" &&
      independentGroups.size >= 3,
    note:
      "Independent operators and elapsed public operation cannot be fabricated by one Codex installation.",
  },
  evidence: {
    codexJobId: evidence.jobId,
    acceptTransactionHash:
      evidence.workerOutcome?.[0]?.state?.jobs?.[evidence.jobId]
        ?.acceptTransactionHash,
    deliverTransactionHash:
      evidence.workerOutcome?.[0]?.state?.jobs?.[evidence.jobId]
        ?.deliverTransactionHash,
    settlementTransactionHash:
      evidence.validatorOutcome?.transactionHash,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!codingReady) process.exitCode = 1;
