import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import solc from "solc";
import {
  ROOT,
  VERSION,
  artifactBytecodeEvidence,
  assertTrackedTreeClean,
  loadAndValidateConfig,
  sha256File,
  sha256Json,
} from "./lib/v44-mainnet.mjs";

const DEFAULT_OUTPUT = path.join(
  ROOT,
  "outputs",
  "v44-source-reproducibility.json",
);

function git(...args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function trackedSolidityBlobs() {
  const lines = git("ls-tree", "-r", "HEAD", "--", "contracts")
    .split(/\r?\n/u)
    .filter(Boolean);
  return lines
    .map((line) => {
      const match = line.match(
        /^(?<mode>[0-9]+) blob (?<blob>[0-9a-f]{40})\t(?<file>.+)$/u,
      );
      if (!match?.groups || !match.groups.file.endsWith(".sol")) return null;
      return {
        file: match.groups.file.replaceAll("\\", "/"),
        gitBlob: match.groups.blob,
        mode: match.groups.mode,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function buildV44ReleaseEvidence({ requireClean = true } = {}) {
  if (requireClean) assertTrackedTreeClean();
  const config = loadAndValidateConfig();
  const sourceCommit = git("rev-parse", "HEAD").toLowerCase();
  const sourceTree = git("rev-parse", "HEAD^{tree}").toLowerCase();
  const body = {
    schema: "agentpool.mainnet.v44.source-reproducibility/v1",
    release: VERSION,
    chainId: 8453,
    sourceCommit,
    sourceTree,
    nodeVersion: process.version,
    solcVersion: solc.version(),
    compilerSettings: {
      optimizer: { enabled: true, runs: 500 },
      viaIR: true,
      evmVersion: "cancun",
    },
    packageLockSha256: sha256File(path.join(ROOT, "package-lock.json")),
    configSha256: config.configSha256,
    financeInvariantHash: config.financeInvariantHash,
    soliditySources: trackedSolidityBlobs(),
    artifacts: artifactBytecodeEvidence(),
    reproduce: [
      "npm ci",
      "npm run contracts:compile",
      "npm run evidence:v4.4:source",
      "npm run evidence:v4.4:source:verify",
    ],
  };
  return {
    ...body,
    evidenceSha256: sha256Json(body),
  };
}

export function verifyV44ReleaseEvidence(
  evidence,
  { requireClean = true } = {},
) {
  const expected = buildV44ReleaseEvidence({ requireClean });
  assert.deepEqual(evidence, expected, "V44_SOURCE_EVIDENCE_MISMATCH");
  return expected;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const verifyPath = argument("--verify");
  if (verifyPath) {
    const evidence = JSON.parse(
      fs.readFileSync(path.resolve(verifyPath), "utf8"),
    );
    const verified = verifyV44ReleaseEvidence(evidence);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        sourceCommit: verified.sourceCommit,
        evidenceSha256: verified.evidenceSha256,
        verifiedPath: path.resolve(verifyPath),
      }, null, 2)}\n`,
    );
  } else {
    const outputPath = path.resolve(argument("--output") ?? DEFAULT_OUTPUT);
    const evidence = buildV44ReleaseEvidence();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        sourceCommit: evidence.sourceCommit,
        evidenceSha256: evidence.evidenceSha256,
        outputPath,
      }, null, 2)}\n`,
    );
  }
}
