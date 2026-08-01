import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("v4.4 build provenance is derived from exact Git blobs", () => {
  const generator = source("scripts/generate-v44-build-manifest.mjs");
  const provenance = source("lib/v44-provenance.ts");
  assert.match(generator, /gitBytes\(\["show", `\$\{interfaceSourceCommit\}:\$\{relativePath\}`\]\)/u);
  assert.match(generator, /generatedFromCleanTree/u);
  assert.match(generator, /sourceTreeManifestRoot/u);
  assert.match(generator, /packageLockSha256/u);
  assert.match(generator, /buildToolchain/u);
  assert.match(generator, /nodeRuntime: process\.version/u);
  assert.match(generator, /buildManifestFileSha256/u);
  assert.match(generator, /maxBuffer:\s*64 \* 1024 \* 1024/u);
  assert.match(provenance, /V44_BUILD_MANIFEST\.generatedFromCleanTree === true/u);
  assert.match(provenance, /REPRODUCIBLE_BUILD_MANIFEST_VERIFIED/u);
});

test("public v4.4 responses expose immutable provenance headers", () => {
  const provenance = source("lib/v44-provenance.ts");
  const worker = source("worker/index.ts");
  for (const header of [
    "x-agentpool-provenance-status",
    "x-agentpool-interface-commit",
    "x-agentpool-site-deployment-version",
    "x-agentpool-build-manifest-sha256",
    "x-agentpool-build-manifest-file-sha256",
    "x-agentpool-source-tree-root",
  ]) {
    assert.match(provenance, new RegExp(header));
  }
  assert.match(worker, /v44ProvenanceHeaders/u);
});
