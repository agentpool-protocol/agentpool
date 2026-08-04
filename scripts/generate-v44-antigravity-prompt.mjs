import { execFileSync } from "node:child_process";
import { buildAntigravityRunnerPrompt } from "./lib/v44-two-runner-prompt.mjs";

const root = process.cwd();
const branch = execFileSync("git", ["branch", "--show-current"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (branch !== "main") throw new Error(`MAIN_BRANCH_REQUIRED:${branch || "DETACHED"}`);

const trackedStatus = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: root, encoding: "utf8" },
).trim();
if (trackedStatus) throw new Error("TRACKED_WORKTREE_MUST_BE_CLEAN");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

console.log(
  buildAntigravityRunnerPrompt({
    workspacePath: root,
    sourceCommit,
  }),
);
