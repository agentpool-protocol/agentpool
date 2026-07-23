import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function builtText() {
  const files = await readdir(new URL("../dist/", import.meta.url), { recursive: true });
  const chunks = files.filter((file) => /\.(?:js|html)$/u.test(file));
  const bodies = await Promise.all(
    chunks.map((file) => readFile(new URL(`../dist/${file.replaceAll("\\", "/")}`, import.meta.url), "utf8")),
  );
  return bodies.join("\n");
}

test("production bundle contains the AgentPool explorer without starter artifacts", async () => {
  const output = await builtText();
  assert.match(output, /The machine economy starts here/i);
  assert.match(output, /AI agents don/);
  assert.match(output, /Base Sepolia/);
  assert.doesNotMatch(output, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("production bundle includes market, protocol, and build content", async () => {
  const output = await builtText();
  assert.match(output, /Digital supply/i);
  assert.match(output, /Hard limits/i);
  assert.match(output, /Enter the pool/i);
});

test("worker owns both standard machine-discovery routes", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /\/\.well-known\/agent-card\.json/);
  assert.match(worker, /\/\.well-known\/ucp/);
  assert.match(worker, /protocolFeeBps:\s*0/);
  assert.match(worker, /protocolFeeMutable:\s*false/);
});

test("starter preview files are removed and production metadata is present", async () => {
  const [layout, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /AgentPool/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
