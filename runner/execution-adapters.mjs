import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";

const PROVIDERS = new Set(["codex", "claude", "qwen"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_CANDIDATE_ARTIFACT_BYTES = 5 * 1024 * 1024;
const WORKSPACE_EVIDENCE_IGNORES = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "outputs",
]);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertWorkspaceAllowed(workspace, allowedRoots) {
  if (!workspace) return;
  if (
    !Array.isArray(allowedRoots) ||
    !allowedRoots.some((root) => isPathInside(root, workspace))
  ) {
    throw new Error("EXECUTOR_WORKSPACE_NOT_ALLOWLISTED");
  }
}

function providerArgs(provider, prompt, schemaPath, outputPath, config) {
  if (provider === "codex") {
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      config.allowWorkspaceWrite === true ? "workspace-write" : "read-only",
    ];
    if (config.ignoreUserConfig !== false) {
      args.push("--ignore-user-config");
    }
    if (config.ignoreRules !== false) {
      args.push("--ignore-rules");
    }
    if (config.skipGitRepoCheck !== false) {
      args.push("--skip-git-repo-check");
    }
    args.push(
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      prompt,
    );
    return args;
  }
  if (provider === "claude") {
    return [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(JSON.parse(fs.readFileSync(schemaPath, "utf8"))),
      "--no-session-persistence",
      "--tools",
      config.allowWorkspaceWrite === true
        ? "Read,Glob,Grep,Edit,Write"
        : "Read,Glob,Grep",
      prompt,
    ];
  }
  if (provider === "qwen") {
    return [
      "-p",
      "--output-format",
      "json",
      "--output-schema",
      schemaPath,
      prompt,
    ];
  }
  throw new Error("EXECUTOR_PROVIDER_UNSUPPORTED");
}

export function resolveProviderLaunch(provider, config = {}) {
  if (!PROVIDERS.has(provider)) {
    throw new Error("EXECUTOR_PROVIDER_UNSUPPORTED");
  }
  if (config.command) {
    return {
      command: String(config.command),
      prefixArgs: Array.isArray(config.commandPrefixArgs)
        ? config.commandPrefixArgs.map(String)
        : [],
      source: "configured",
    };
  }
  if (provider === "codex") {
    const localCodex = path.join(
      projectRoot,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fs.existsSync(localCodex)) {
      return {
        command: process.execPath,
        prefixArgs: [localCodex],
        source: "project-local-codex",
      };
    }
  }
  return {
    command: provider,
    prefixArgs: [],
    source: "path",
  };
}

function parseProviderOutput(provider, stdout, outputFile) {
  if (provider === "codex" && fs.existsSync(outputFile)) {
    return JSON.parse(fs.readFileSync(outputFile, "utf8"));
  }
  const parsed = JSON.parse(stdout.trim());
  if (provider === "claude" && parsed.structured_output) {
    return parsed.structured_output;
  }
  if (provider === "claude" && typeof parsed.result === "string") {
    try {
      return JSON.parse(parsed.result);
    } catch {
      return { content: parsed.result };
    }
  }
  return parsed;
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("EXECUTOR_TIMEOUT"));
    }, options.timeoutMs);
    const collect = (target, chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) {
        child.kill();
        reject(new Error("EXECUTOR_OUTPUT_LIMIT_EXCEEDED"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `EXECUTOR_PROCESS_FAILED:${code ?? signal}:${err.slice(0, 2_000)}`,
          ),
        );
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

async function workspaceFileHashes(workspace) {
  const hashes = new Map();
  const visit = async (directory) => {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (WORKSPACE_EVIDENCE_IGNORES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path
        .relative(workspace, absolute)
        .replaceAll("\\", "/");
      const content = await fs.promises.readFile(absolute);
      hashes.set(
        relative,
        createHash("sha256").update(content).digest("hex"),
      );
    }
  };
  await visit(workspace);
  return hashes;
}

function changedWorkspaceFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function workspacePatchDigest(changedFiles, after) {
  const digest = createHash("sha256");
  for (const file of changedFiles) {
    digest.update(file);
    digest.update("\0");
    digest.update(after.get(file) ?? "DELETED");
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized === value &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    normalized.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

async function createCandidateWorkspace(baseWorkspace, config) {
  const root = path.resolve(
    config.candidateWorkspaceRoot ??
      path.join(path.dirname(baseWorkspace), "candidates"),
  );
  assertWorkspaceAllowed(root, config.allowedWorkspaceRoots ?? []);
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, "candidate-"));
  await cp(baseWorkspace, workspace, {
    recursive: true,
    force: true,
    filter: (candidate) => {
      const relative = path.relative(baseWorkspace, candidate);
      return !relative
        .split(path.sep)
        .some((segment) => WORKSPACE_EVIDENCE_IGNORES.has(segment));
    },
  });
  return workspace;
}

async function persistCandidateArtifact({
  baseWorkspace,
  candidateWorkspace,
  before,
  after,
  changedFiles,
  patchDigest,
  sourceSnapshotDigest,
  verification,
  canary,
  config,
}) {
  const changes = [];
  let payloadBytes = 0;
  for (const file of changedFiles) {
    const absolute = path.join(candidateWorkspace, file);
    const exists = fs.existsSync(absolute);
    const content = exists ? await fs.promises.readFile(absolute) : null;
    payloadBytes += content?.byteLength ?? 0;
    if (
      payloadBytes >
      Number(
        config.maxCandidateArtifactBytes ??
          DEFAULT_MAX_CANDIDATE_ARTIFACT_BYTES,
      )
    ) {
      throw new Error("CANDIDATE_ARTIFACT_SIZE_LIMIT_EXCEEDED");
    }
    changes.push({
      path: file,
      action: exists ? (before.has(file) ? "MODIFY" : "ADD") : "DELETE",
      beforeSha256: before.get(file) ?? null,
      afterSha256: after.get(file) ?? null,
      contentBase64: content?.toString("base64") ?? null,
    });
  }
  const manifest = {
    schema: "agentpool.candidate.patch/v1",
    sourceSnapshotDigest,
    patchDigest,
    testCommand: verification.testCommand,
    testPassed: verification.testPassed,
    objectiveCanary: canary,
    changes,
  };
  const serialized = `${JSON.stringify(manifest)}\n`;
  const artifactDigest = `sha256:${sha256(serialized)}`;
  const artifactRoot = path.resolve(
    config.candidateArtifactRoot ??
      path.join(path.dirname(baseWorkspace), "candidate-artifacts"),
  );
  assertWorkspaceAllowed(artifactRoot, config.allowedWorkspaceRoots ?? []);
  await mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(
    artifactRoot,
    `${artifactDigest.slice("sha256:".length)}.json`,
  );
  await writeFile(artifactPath, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    artifactDigest,
    artifactPath,
    artifactSizeBytes: Buffer.byteLength(serialized),
  };
}

export async function materializeCandidateArtifact({
  baseWorkspace,
  artifactPath,
  artifactDigest,
  targetRoot,
}) {
  const serialized = await fs.promises.readFile(artifactPath, "utf8");
  const computedArtifactDigest = `sha256:${sha256(serialized)}`;
  if (computedArtifactDigest !== artifactDigest) {
    throw new Error("CANDIDATE_ARTIFACT_DIGEST_MISMATCH");
  }
  let manifest;
  try {
    manifest = JSON.parse(serialized);
  } catch {
    throw new Error("CANDIDATE_ARTIFACT_JSON_INVALID");
  }
  if (
    manifest?.schema !== "agentpool.candidate.patch/v1" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(manifest.sourceSnapshotDigest ?? ""),
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(manifest.patchDigest ?? "")) ||
    manifest.testPassed !== true ||
    manifest.objectiveCanary?.passed !== true ||
    typeof manifest.testCommand !== "string" ||
    !Array.isArray(manifest.changes) ||
    manifest.changes.length === 0 ||
    manifest.changes.length > 40
  ) {
    throw new Error("CANDIDATE_ARTIFACT_MANIFEST_INVALID");
  }
  const baseDigest = await computeWorkspaceDigest(baseWorkspace);
  if (baseDigest !== manifest.sourceSnapshotDigest) {
    throw new Error("CANDIDATE_ARTIFACT_SOURCE_MISMATCH");
  }
  await mkdir(targetRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(targetRoot, "replay-"));
  await cp(baseWorkspace, workspace, {
    recursive: true,
    force: true,
    filter: (candidate) => {
      const relative = path.relative(baseWorkspace, candidate);
      return !relative
        .split(path.sep)
        .some((segment) => WORKSPACE_EVIDENCE_IGNORES.has(segment));
    },
  });
  const before = await workspaceFileHashes(workspace);
  try {
    for (const change of manifest.changes) {
      if (
        !validArtifactPath(change?.path) ||
        !["ADD", "MODIFY", "DELETE"].includes(change?.action) ||
        (change.beforeSha256 !== null &&
          !/^[0-9a-f]{64}$/.test(String(change.beforeSha256))) ||
        (change.afterSha256 !== null &&
          !/^[0-9a-f]{64}$/.test(String(change.afterSha256))) ||
        before.get(change.path) !== (change.beforeSha256 ?? undefined)
      ) {
        throw new Error("CANDIDATE_ARTIFACT_CHANGE_INVALID");
      }
      const absolute = path.resolve(workspace, change.path);
      if (!isPathInside(workspace, absolute)) {
        throw new Error("CANDIDATE_ARTIFACT_PATH_ESCAPE");
      }
      if (change.action === "DELETE") {
        if (
          change.afterSha256 !== null ||
          change.contentBase64 !== null ||
          !fs.existsSync(absolute)
        ) {
          throw new Error("CANDIDATE_ARTIFACT_DELETE_INVALID");
        }
        await unlink(absolute);
        continue;
      }
      if (
        typeof change.contentBase64 !== "string" ||
        change.afterSha256 === null
      ) {
        throw new Error("CANDIDATE_ARTIFACT_CONTENT_REQUIRED");
      }
      const content = Buffer.from(change.contentBase64, "base64");
      if (sha256(content) !== change.afterSha256) {
        throw new Error("CANDIDATE_ARTIFACT_CONTENT_HASH_MISMATCH");
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, { mode: 0o600 });
    }
    const after = await workspaceFileHashes(workspace);
    const changedFiles = changedWorkspaceFiles(before, after);
    const patchDigest = workspacePatchDigest(changedFiles, after);
    if (
      patchDigest !== manifest.patchDigest ||
      changedFiles.join("\0") !==
        manifest.changes.map((change) => change.path).sort().join("\0")
    ) {
      throw new Error("CANDIDATE_ARTIFACT_PATCH_MISMATCH");
    }
    return {
      workspace,
      manifest,
      sourceSnapshotDigest: baseDigest,
      patchDigest,
      changedFiles,
    };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function computeWorkspaceDigest(workspace) {
  const hashes = await workspaceFileHashes(workspace);
  const digest = createHash("sha256");
  for (const [file, hash] of [...hashes.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(file);
    digest.update("\0");
    digest.update(hash);
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

export async function verifyPublishedCandidateArtifact({
  baseWorkspace,
  artifactJson,
  artifactDigest,
  targetRoot,
  config = {},
}) {
  if (typeof artifactJson !== "string" || artifactJson.length === 0) {
    throw new Error("CANDIDATE_ARTIFACT_JSON_REQUIRED");
  }
  await mkdir(targetRoot, { recursive: true });
  const downloadRoot = await mkdtemp(
    path.join(targetRoot, "download-"),
  );
  const artifactPath = path.join(downloadRoot, "candidate.json");
  await writeFile(artifactPath, artifactJson, {
    encoding: "utf8",
    mode: 0o600,
  });
  let replay;
  try {
    replay = await materializeCandidateArtifact({
      baseWorkspace,
      artifactPath,
      artifactDigest,
      targetRoot,
    });
    const verification = await verifyCandidateWorkspace(
      replay.workspace,
      config,
    );
    const canary = await verifyObjectiveCandidateCanary({
      baseWorkspace,
      candidateWorkspace: replay.workspace,
      changedFiles: replay.changedFiles,
      candidateVerification: verification,
      config: {
        ...config,
        candidateWorkspaceRoot: targetRoot,
      },
    });
    return {
      sourceSnapshotDigest: replay.sourceSnapshotDigest,
      patchDigest: replay.patchDigest,
      changedFiles: replay.changedFiles,
      testCommand: verification.testCommand,
      testPassed: verification.testPassed,
      objectiveCanaryPassed: canary.passed,
      objectiveCanaryReason: canary.reason,
      candidateMetrics: canary.candidateMetrics,
      baselineMetrics: canary.baselineMetrics,
    };
  } finally {
    if (replay?.workspace) {
      await rm(replay.workspace, { recursive: true, force: true });
    }
    await rm(downloadRoot, { recursive: true, force: true });
  }
}

async function verifyCandidateWorkspace(workspace, config) {
  const testsDirectory = path.join(workspace, "tests");
  const testFiles = fs.existsSync(testsDirectory)
    ? (await fs.promises.readdir(testsDirectory))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => `tests/${name}`)
    : [];
  const testCommand = "node --test tests/*.test.mjs";
  if (testFiles.length === 0) {
    return { testCommand, testPassed: false, durationMs: 0 };
  }
  const startedAt = Date.now();
  try {
    await runProcess(process.execPath, ["--test", ...testFiles], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
      },
      timeoutMs: Number(
        config.candidateVerificationTimeoutMs ?? 180_000,
      ),
      maxOutputBytes: Number(
        config.candidateVerificationMaxOutputBytes ??
          DEFAULT_MAX_OUTPUT_BYTES,
      ),
    });
    return {
      testCommand,
      testPassed: true,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  } catch {
    return {
      testCommand,
      testPassed: false,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }
}

async function verifyObjectiveCandidateCanary({
  baseWorkspace,
  candidateWorkspace,
  changedFiles,
  candidateVerification,
  config,
}) {
  const changedTests = changedFiles.filter(
    (file) =>
      file.startsWith("tests/") &&
      file.endsWith(".test.mjs") &&
      fs.existsSync(path.join(candidateWorkspace, file)),
  );
  const root = path.resolve(
    config.candidateWorkspaceRoot ??
      path.join(path.dirname(baseWorkspace), "candidates"),
  );
  const baselineWorkspace = await mkdtemp(
    path.join(root, "baseline-canary-"),
  );
  try {
    await cp(baseWorkspace, baselineWorkspace, {
      recursive: true,
      force: true,
      filter: (candidate) => {
        const relative = path.relative(baseWorkspace, candidate);
        return !relative
          .split(path.sep)
          .some((segment) => WORKSPACE_EVIDENCE_IGNORES.has(segment));
      },
    });
    for (const file of changedTests) {
      const source = path.join(candidateWorkspace, file);
      const destination = path.join(baselineWorkspace, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(source, destination);
    }
    const baselineVerification = await verifyCandidateWorkspace(
      baselineWorkspace,
      config,
    );
    const candidateMetrics = {
      qualityBps: candidateVerification.testPassed ? 10_000 : 0,
      cost: candidateVerification.durationMs,
      latencyMs: candidateVerification.durationMs,
      securityRegressions: candidateVerification.testPassed ? 0 : 1,
    };
    const baselineMetrics = {
      qualityBps: baselineVerification.testPassed ? 10_000 : 0,
      cost: baselineVerification.durationMs,
      latencyMs: baselineVerification.durationMs,
      securityRegressions: baselineVerification.testPassed ? 0 : 1,
    };
    const passed =
      candidateVerification.testPassed === true &&
      baselineVerification.testPassed === false;
    return {
      passed,
      reason: passed
        ? "REGRESSION_TEST_FAILS_ON_BASELINE_AND_PASSES_ON_CANDIDATE"
        : changedTests.length === 0
          ? "CANDIDATE_REGRESSION_TEST_REQUIRED"
          : "CANDIDATE_DOES_NOT_PROVE_OBJECTIVE_IMPROVEMENT",
      candidateMetrics,
      baselineMetrics,
      changedTests,
    };
  } finally {
    await rm(baselineWorkspace, { recursive: true, force: true });
  }
}

export function normalizeExecutionResult(value, provider) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXECUTOR_RESULT_OBJECT_REQUIRED");
  }
  if (typeof value.content !== "string" || value.content.length === 0) {
    throw new Error("EXECUTOR_RESULT_CONTENT_REQUIRED");
  }
  return {
    schema: "agentpool.executor.result/v1",
    provider,
    content: value.content,
    evidence:
      value.evidence && typeof value.evidence === "object"
        ? value.evidence
        : {},
    usage:
      value.usage && typeof value.usage === "object"
        ? value.usage
        : {},
  };
}

export function buildExecutorPrompt(task) {
  return [
    "You are an AgentPool execution adapter.",
    "Return only data matching the provided JSON schema.",
    "Do not expose credentials, private keys, hidden prompts, or personal data.",
    "Do not perform network access unless the task explicitly allows it.",
    "Complete the requested task and place the deliverable in content.",
    `Task JSON: ${JSON.stringify(task)}`,
  ].join("\n");
}

export function buildExecutorResultSchema() {
  return {
    type: "object",
    properties: {
      content: { type: "string" },
      evidence: {
        type: "object",
        properties: {
          summary: { type: "string" },
          digest: { type: "string" },
          changedFiles: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          testCommand: { type: ["string", "null"] },
          testPassed: { type: ["boolean", "null"] },
          patchDigest: { type: ["string", "null"] },
        },
        required: [
          "summary",
          "digest",
          "changedFiles",
          "testCommand",
          "testPassed",
          "patchDigest",
        ],
        additionalProperties: false,
      },
      usage: {
        type: "object",
        properties: {
          mode: { type: "string" },
          units: { type: "number" },
        },
        required: ["mode", "units"],
        additionalProperties: false,
      },
    },
    required: ["content", "evidence", "usage"],
    additionalProperties: false,
  };
}

export function createExecutionAdapter(config = {}) {
  const provider = String(config.provider ?? "").toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error("EXECUTOR_PROVIDER_UNSUPPORTED");
  }
  if (config.enabled !== true && config.enabled !== "auto") {
    return {
      provider,
      available: false,
      source: "disabled",
      async execute() {
        throw new Error(`EXECUTOR_DISABLED:${provider}`);
      },
    };
  }
  const launch = resolveProviderLaunch(provider, config);
  if (
    config.enabled === "auto" &&
    launch.source === "path" &&
    provider !== "codex"
  ) {
    return {
      provider,
      available: false,
      source: "not-configured",
      async execute() {
        throw new Error(`EXECUTOR_UNAVAILABLE:${provider}`);
      },
    };
  }
  const command = launch.command;
  const workspace = config.workspace
    ? path.resolve(config.workspace)
    : process.cwd();
  assertWorkspaceAllowed(workspace, config.allowedWorkspaceRoots ?? []);
  return {
    provider,
    available: true,
    source: launch.source,
    async execute(task) {
      const temporary = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), `agentpool-${provider}-`),
      );
      const verifyCandidate =
        task.workspaceMode === "ISOLATED_CANARY" &&
        config.verifyCandidateWorkspace !== false;
      const executionWorkspace = verifyCandidate
        ? await createCandidateWorkspace(workspace, config)
        : workspace;
      const schemaPath = path.join(temporary, "result.schema.json");
      const outputPath = path.join(temporary, "result.json");
      const workspaceBefore = verifyCandidate
        ? await workspaceFileHashes(executionWorkspace)
        : null;
      const actualSourceSnapshotDigest = verifyCandidate
        ? await computeWorkspaceDigest(workspace)
        : null;
      if (
        verifyCandidate &&
        config.sourceSnapshotDigest &&
        config.sourceSnapshotDigest !== actualSourceSnapshotDigest
      ) {
        await rm(temporary, { recursive: true, force: true });
        await rm(executionWorkspace, {
          recursive: true,
          force: true,
        });
        throw new Error("EXECUTOR_SOURCE_SNAPSHOT_DIGEST_MISMATCH");
      }
      const schema = buildExecutorResultSchema();
      await mkdir(temporary, { recursive: true });
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      const prompt = buildExecutorPrompt(task);
      const executionConfig = {
        ...config,
        allowWorkspaceWrite:
          task.workspaceMode === "ISOLATED_CANARY" &&
          config.allowWorkspaceWrite === true,
      };
      const generatedArgs = Array.isArray(config.args)
        ? config.args.map((item) =>
            String(item)
              .replaceAll("{prompt}", prompt)
              .replaceAll("{schema}", schemaPath)
              .replaceAll("{output}", outputPath),
          )
        : providerArgs(
            provider,
            prompt,
            schemaPath,
            outputPath,
            executionConfig,
          );
      const args = [...launch.prefixArgs, ...generatedArgs];
      try {
        const result = await runProcess(command, args, {
          cwd: executionWorkspace,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            APPDATA: process.env.APPDATA,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            HOMEDRIVE: process.env.HOMEDRIVE,
            HOMEPATH: process.env.HOMEPATH,
            ...(config.environment ?? {}),
          },
          timeoutMs: Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          maxOutputBytes: Number(
            config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          ),
        });
        const normalized = normalizeExecutionResult(
          parseProviderOutput(provider, result.stdout, outputPath),
          provider,
        );
        if (verifyCandidate) {
          const workspaceAfter =
            await workspaceFileHashes(executionWorkspace);
          const changedFiles = changedWorkspaceFiles(
            workspaceBefore,
            workspaceAfter,
          );
          const verification = await verifyCandidateWorkspace(
            executionWorkspace,
            config,
          );
          const canary = await verifyObjectiveCandidateCanary({
            baseWorkspace: workspace,
            candidateWorkspace: executionWorkspace,
            changedFiles,
            candidateVerification: verification,
            config,
          });
          const patchDigest = workspacePatchDigest(
            changedFiles,
            workspaceAfter,
          );
          const sourceSnapshotDigest =
            actualSourceSnapshotDigest;
          const artifact = await persistCandidateArtifact({
            baseWorkspace: workspace,
            candidateWorkspace: executionWorkspace,
            before: workspaceBefore,
            after: workspaceAfter,
            changedFiles,
            patchDigest,
            sourceSnapshotDigest,
            verification,
            canary,
            config,
          });
          normalized.evidence = {
            ...normalized.evidence,
            changedFiles,
            testCommand: verification.testCommand,
            testPassed: verification.testPassed,
            patchDigest,
            sourceSnapshotDigest,
            artifactDigest: artifact.artifactDigest,
            artifactSizeBytes: artifact.artifactSizeBytes,
            localArtifactPath: artifact.artifactPath,
            objectiveCanaryPassed: canary.passed,
            objectiveCanaryReason: canary.reason,
            candidateMetrics: canary.candidateMetrics,
            baselineMetrics: canary.baselineMetrics,
            hostVerified: true,
          };
        }
        return normalized;
      } finally {
        await rm(temporary, { recursive: true, force: true });
        if (verifyCandidate) {
          await rm(executionWorkspace, {
            recursive: true,
            force: true,
          });
        }
      }
    },
  };
}

export function createExecutorRegistry(config = {}) {
  const adapters = new Map();
  for (const provider of PROVIDERS) {
    const adapter = createExecutionAdapter({
      provider,
      ...(config[provider] ?? {}),
    });
    adapters.set(provider, adapter);
  }
  const preferredProviders = Array.isArray(config.preferredProviders)
    ? config.preferredProviders.map((provider) =>
        String(provider).toLowerCase(),
      )
    : ["codex", "claude", "qwen"];
  return {
    providers() {
      return [...adapters.values()].map(({ provider, available, source }) => ({
        provider,
        available,
        source,
      }));
    },
    async execute(task) {
      const requestedProvider = String(task.provider ?? "").toLowerCase();
      let provider = requestedProvider;
      let adapter = adapters.get(provider);
      if (
        (!adapter?.available || !provider) &&
        task.providerRequired !== true &&
        config.allowProviderFallback !== false
      ) {
        provider =
          preferredProviders.find(
            (candidate) => adapters.get(candidate)?.available,
          ) ?? "";
        adapter = adapters.get(provider);
      }
      if (!adapter) throw new Error("EXECUTOR_PROVIDER_UNSUPPORTED");
      if (!adapter.available) {
        throw new Error(`EXECUTOR_UNAVAILABLE:${requestedProvider}`);
      }
      const result = await adapter.execute({ ...task, provider });
      if (provider && provider !== requestedProvider) {
        result.evidence = {
          ...result.evidence,
          routing: {
            requestedProvider: requestedProvider || null,
            actualProvider: provider,
            fallback: true,
          },
        };
      }
      return result;
    },
  };
}
