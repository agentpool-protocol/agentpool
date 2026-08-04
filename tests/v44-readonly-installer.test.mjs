import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "runner", "Install-AgentPoolV44ReadOnly.ps1");
const installerSource = fs.readFileSync(installer, "utf8");
const bundle = fs.readFileSync(
  path.join(root, "public", "agentpool-v44-readonly-bundle.json"),
);
const buildManifestObject = {
  schema: "agentpool.v44.interface-build-manifest/v1",
  interfaceSourceCommit: "1".repeat(40),
  siteBuildCommit: "1".repeat(40),
  sourceTreeManifestRoot: "3".repeat(64),
  buildManifestSha256: "4".repeat(64),
};
const buildManifest = Buffer.from(
  `${JSON.stringify(buildManifestObject, null, 2)}\n`,
  "utf8",
);
const buildManifestFileSha256 = crypto
  .createHash("sha256")
  .update(buildManifest)
  .digest("hex");

function statusPayload(release) {
  return {
    release,
    chainId: 84532,
    readiness: { publicWriteReady: false },
    provenance: {
      complete: true,
      status: "REPRODUCIBLE_BUILD_MANIFEST_VERIFIED",
      contractSourceCommit: "b535be69d179d39c2f118a80e8927961fbb20a4e",
      interfaceSourceCommit: "1".repeat(40),
      siteBuildCommit: "1".repeat(40),
      sourceTreeArchiveSha256: "2".repeat(64),
      sourceTreeManifestRoot: buildManifestObject.sourceTreeManifestRoot,
      buildManifestSha256: buildManifestObject.buildManifestSha256,
      buildManifestFileSha256,
      siteDeploymentVersion: "test-version",
    },
  };
}

test("read-only installer declares fail-closed integrity guards", () => {
  assert.match(installerSource, /Custom mirrors are blocked/u);
  assert.match(
    installerSource,
    /\$expectedBundleSha256 = "[0-9a-f]{64}"/u,
  );
  assert.match(installerSource, /System\.Security\.Cryptography\.SHA256/u);
  assert.doesNotMatch(installerSource, /\bGet-FileHash\b/u);
  assert.match(installerSource, /\/api\/mcp\/v4\.4/u);
  assert.match(installerSource, /provenance\.complete/u);
  assert.match(installerSource, /wallet = \$null/u);
  assert.match(installerSource, /autoStart = \$false/u);
});

test(
  "read-only installer pins origin, remote MCP, and exact bundle bytes",
  { skip: process.platform !== "win32" },
  async () => {
  let tampered = false;
  let tamperedStatusHeader = false;
  const parsedBundle = JSON.parse(bundle.toString("utf8"));
  const server = http.createServer((request, response) => {
    if (request.url === "/agentpool-v44-readonly-bundle.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(tampered ? Buffer.concat([bundle, Buffer.from(" ")]) : bundle);
      return;
    }
    if (request.url === "/api/v4.4/status") {
      const status = statusPayload(parsedBundle.release);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-agentpool-provenance-status": status.provenance.status,
        "x-agentpool-interface-commit":
          status.provenance.interfaceSourceCommit,
        "x-agentpool-site-deployment-version":
          status.provenance.siteDeploymentVersion,
        "x-agentpool-build-manifest-sha256":
          tamperedStatusHeader
            ? "f".repeat(64)
            : status.provenance.buildManifestSha256,
        "x-agentpool-build-manifest-file-sha256":
          status.provenance.buildManifestFileSha256,
        "x-agentpool-source-tree-root":
          status.provenance.sourceTreeManifestRoot,
      });
      response.end(JSON.stringify(status));
      return;
    }
    if (request.url === "/agentpool-v44-build-manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(buildManifest);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentpool-v44-installer-"));
  try {
    await assert.rejects(
      execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-BaseUrl",
        baseUrl,
        "-InstallRoot",
        path.join(tempRoot, "custom-origin"),
      ]),
      /Custom mirrors are blocked/u,
    );

    const successfulRoot = path.join(tempRoot, "verified");
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-BaseUrl",
      baseUrl,
      "-UnsafeCustomMirror",
      "-InstallRoot",
      successfulRoot,
    ]);
    const config = JSON.parse(
      fs
        .readFileSync(path.join(successfulRoot, "mcp-readonly.json"), "utf8")
        .replace(/^\uFEFF/u, ""),
    );
    assert.equal(config.url, parsedBundle.remoteMcp);
    assert.equal(config.mode, "read-only");
    assert.equal(config.interfaceSourceCommit, "1".repeat(40));

    tamperedStatusHeader = true;
    await assert.rejects(
      execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-BaseUrl",
        baseUrl,
        "-UnsafeCustomMirror",
        "-InstallRoot",
        path.join(tempRoot, "tampered-status-header"),
      ]),
      /complete read-only build provenance/u,
    );
    tamperedStatusHeader = false;

    tampered = true;
    await assert.rejects(
      execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-BaseUrl",
        baseUrl,
        "-UnsafeCustomMirror",
        "-InstallRoot",
        path.join(tempRoot, "tampered"),
      ]),
      /SHA-256 mismatch/u,
    );
    assert.equal(
      fs.existsSync(path.join(tempRoot, "tampered", "mcp-readonly.json")),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  },
);
