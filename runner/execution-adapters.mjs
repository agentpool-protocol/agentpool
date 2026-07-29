import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";

const PROVIDERS = new Set(["codex", "claude", "qwen"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
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
    return { testCommand, testPassed: false };
  }
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
    return { testCommand, testPassed: true };
  } catch {
    return { testCommand, testPassed: false };
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
      const schemaPath = path.join(temporary, "result.schema.json");
      const outputPath = path.join(temporary, "result.json");
      const verifyCandidate =
        task.workspaceMode === "ISOLATED_CANARY" &&
        config.verifyCandidateWorkspace !== false;
      const workspaceBefore = verifyCandidate
        ? await workspaceFileHashes(workspace)
        : null;
      const schema = buildExecutorResultSchema();
      await mkdir(temporary, { recursive: true });
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      const prompt = buildExecutorPrompt(task);
      const generatedArgs = Array.isArray(config.args)
        ? config.args.map((item) =>
            String(item)
              .replaceAll("{prompt}", prompt)
              .replaceAll("{schema}", schemaPath)
              .replaceAll("{output}", outputPath),
          )
        : providerArgs(provider, prompt, schemaPath, outputPath, config);
      const args = [...launch.prefixArgs, ...generatedArgs];
      try {
        const result = await runProcess(command, args, {
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
          const workspaceAfter = await workspaceFileHashes(workspace);
          const changedFiles = changedWorkspaceFiles(
            workspaceBefore,
            workspaceAfter,
          );
          const verification = await verifyCandidateWorkspace(
            workspace,
            config,
          );
          normalized.evidence = {
            ...normalized.evidence,
            changedFiles,
            testCommand: verification.testCommand,
            testPassed: verification.testPassed,
            patchDigest: workspacePatchDigest(
              changedFiles,
              workspaceAfter,
            ),
            hostVerified: true,
          };
        }
        return normalized;
      } finally {
        await rm(temporary, { recursive: true, force: true });
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
