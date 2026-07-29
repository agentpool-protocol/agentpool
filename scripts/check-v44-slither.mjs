import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONTRACT_TYPES,
  ROOT,
  artifact,
} from "./lib/v44-mainnet.mjs";

const BASELINE_PATH = path.join(
  ROOT,
  "audits",
  "v44-slither-baseline.json",
);
const SLITHER = process.env.SLITHER_BIN?.trim() || "slither";
const SOLC = process.env.SOLC_BIN?.trim() || "solc";
const PRINT_BASELINE = process.argv.includes("--print-baseline");
const SOLC_ARGS =
  "--base-path . --include-path node_modules --allow-paths . " +
  "--optimize --optimize-runs 500 --via-ir";

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

function requireVersion(command, args, expected, label) {
  const result = run(command, args);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error || result.status !== 0 || !expected.test(output)) {
    throw new Error(
      `V44_SLITHER_${label}_VERSION_INVALID:${output || result.error?.message}`,
    );
  }
  return output.split(/\r?\n/u).find((line) => expected.test(line))?.trim();
}

function detectorProfile(detectors) {
  const profile = {};
  for (const detector of detectors) {
    if (detector.impact !== "High" && detector.impact !== "Medium") continue;
    const key = `${detector.impact}:${detector.check}`;
    profile[key] = (profile[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(profile).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const slitherVersion = requireVersion(
  SLITHER,
  ["--version"],
  /^0\.11\.6$/mu,
  "TOOL",
);
const solcVersionLine = requireVersion(
  SOLC,
  ["--version"],
  /Version:\s*0\.8\.36\+commit\.8a079791/mu,
  "SOLC",
);
const solcVersion =
  solcVersionLine.match(/0\.8\.36\+commit\.8a079791/u)?.[0];

const tempDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "agentpool-v44-slither-"),
);

try {
  const contractNames = [...new Set(Object.values(CONTRACT_TYPES))].sort();
  const contracts = {};

  for (const contractName of contractNames) {
    const sourceName = artifact(contractName).sourceName;
    const outputPath = path.join(tempDirectory, `${contractName}.json`);
    const result = run(SLITHER, [
      sourceName,
      "--solc",
      SOLC,
      "--solc-args",
      SOLC_ARGS,
      "--exclude-dependencies",
      "--json",
      outputPath,
    ]);
    if (!fs.existsSync(outputPath)) {
      throw new Error(
        `V44_SLITHER_OUTPUT_MISSING:${contractName}:` +
          `${result.stderr || result.stdout || result.error?.message}`,
      );
    }
    const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const detectors = report.results?.detectors || [];
    if (report.success !== true || !Array.isArray(detectors)) {
      throw new Error(`V44_SLITHER_REPORT_INVALID:${contractName}`);
    }
    contracts[contractName] = {
      sourceName,
      detectors: detectorProfile(detectors),
    };
  }

  const observed = {
    schema: "agentpool.security.slither-baseline/v1",
    slitherVersion,
    solcVersion,
    compilerSettings: {
      optimizer: true,
      optimizerRuns: 500,
      viaIR: true,
      excludeDependencies: true,
    },
    contracts,
  };

  if (PRINT_BASELINE) {
    process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
    process.exit(0);
  }

  const expected = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  if (!sameJson(observed, expected)) {
    process.stderr.write(
      `${JSON.stringify({ expected, observed }, null, 2)}\n`,
    );
    throw new Error("V44_SLITHER_BASELINE_CHANGED");
  }

  const totals = Object.values(contracts).reduce(
    (sum, entry) => {
      for (const [key, count] of Object.entries(entry.detectors)) {
        if (key.startsWith("High:")) sum.high += count;
        if (key.startsWith("Medium:")) sum.medium += count;
      }
      return sum;
    },
    { high: 0, medium: 0 },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        contracts: Object.keys(contracts).length,
        highReported: totals.high,
        mediumReported: totals.medium,
        baseline: path.relative(ROOT, BASELINE_PATH),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
