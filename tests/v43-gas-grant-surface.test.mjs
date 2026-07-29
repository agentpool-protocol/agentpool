import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("gas grant route is signed, same-recipient, capped, and testnet-only", async () => {
  const source = await readFile(
    new URL("app/api/v4.3/gas/grants/route.ts", root),
    "utf8",
  );
  assert.match(source, /signedV43Write/);
  assert.match(source, /gasRequest\.actor_address !== normalizedRecipient/);
  assert.match(source, /to:\s*auth\.address/);
  assert.match(source, /chain:\s*baseSepolia/);
  assert.match(source, /V43_GAS_GRANT_DAILY_COUNT_CAP/);
  assert.match(source, /V43_GAS_GRANT_DAILY_WEI_CAP/);
  assert.match(source, /duplicateSuppressed/);
  assert.doesNotMatch(source, /baseMainnet|chainId:\s*8453[,}]/);
  assert.doesNotMatch(source, /recipientAddress:\s*z\./);
});
