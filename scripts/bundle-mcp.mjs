import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "public", "agentpool-mcp.mjs");

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "mcp", "agentpool-v43.mjs")],
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
await writeFile(outfile, bundledSource.replace(/[ \t]+$/gmu, ""), "utf8");
