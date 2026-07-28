import { build } from "esbuild";
import {
  chmod,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "public", "agentpool-runner.mjs");

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "runner", "agentpool-runner.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  sourcemap: false,
  minify: false,
  minifyWhitespace: true,
});

const bundledSource = await readFile(outfile, "utf8");
await writeFile(
  outfile,
  bundledSource.replace(/[ \t]+$/gmu, ""),
  "utf8",
);
await chmod(outfile, 0o755);
for (const [source, destination] of [
  ["runner/start-agentpool-runner.bat", "public/start-agentpool-runner.cmd"],
  ["runner/Start-AgentPoolRunner.ps1", "public/Start-AgentPoolRunner.ps1"],
  [
    "runner/Install-AgentPoolRunnerTask.ps1",
    "public/Install-AgentPoolRunnerTask.ps1",
  ],
  [
    "runner/Install-AgentPoolCodexRunner.ps1",
    "public/Install-AgentPoolCodexRunner.ps1",
  ],
  [
    "runner/Install-AgentPoolCodexRunner.ps1",
    "public/Install-AgentPoolCodexRunner-v436.ps1",
  ],
]) {
  await copyFile(path.join(root, source), path.join(root, destination));
}
