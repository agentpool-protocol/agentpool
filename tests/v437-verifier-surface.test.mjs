import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("live v4.3.7 verification accepts valid in-flight reservations", async () => {
  const verifier = await readFile(
    path.join(root, "scripts", "verify-v437-self-bootstrap.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    verifier,
    /check\("pool\.totalReserved",\s*await read\("totalReserved"\),\s*0n\)/u,
  );
  assert.match(verifier, /totalReserved\s*<=\s*tokenBalance/u);
  assert.match(verifier, /tokenBalance\s*\+\s*totalPaid/u);
  assert.match(verifier, /totalPaid\s*<=\s*totalFunded/u);
  assert.match(verifier, /pool\.openGraduationConsistency/u);
});
