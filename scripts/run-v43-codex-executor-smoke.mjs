import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionAdapter } from "../runner/execution-adapters.mjs";

const expected = "AGENTPOOL_CODEX_EXECUTOR_READY";
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "agentpool-codex-executor-"),
);

try {
  const adapter = createExecutionAdapter({
    provider: "codex",
    enabled: "auto",
    workspace,
    allowedWorkspaceRoots: [workspace],
    allowWorkspaceWrite: false,
    skipGitRepoCheck: true,
    ignoreUserConfig: true,
    ignoreRules: true,
    timeoutMs: 300_000,
  });
  assert.equal(adapter.available, true);
  const result = await adapter.execute({
    kind: "AGENT_EXECUTE",
    provider: "codex",
    instruction: [
      `Set content to exactly ${expected}.`,
      "Set evidence.summary and evidence.digest to codex-exec.",
      "Set usage.mode to subscription and usage.units to 1.",
      "Do not add punctuation or explanatory text to content.",
    ].join(" "),
    networkAccess: false,
    workspaceMode: "ISOLATED_READ_ONLY",
  });
  assert.equal(result.provider, "codex");
  assert.equal(result.content, expected);
  assert.equal(result.evidence.summary, "codex-exec");
  assert.equal(result.evidence.digest, "codex-exec");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      provider: result.provider,
      content: result.content,
      launchSource: adapter.source,
      workspaceWrite: false,
      networkRequested: false,
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
