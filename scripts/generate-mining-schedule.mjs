import fs from "node:fs";
import path from "node:path";

const epochs = 520;
const totalWei = 500_000_000n * 10n ** 18n;
const weeklyRatio = Math.pow(0.85, 1 / 52);
const weights = Array.from({ length: epochs }, (_, epoch) => Math.pow(weeklyRatio, epoch));
const weightTotal = weights.reduce((sum, value) => sum + value, 0);
const budgets = weights.map((weight) =>
  BigInt(Math.floor(Number(totalWei / 10n ** 12n) * weight / weightTotal)) * 10n ** 12n,
);
const assigned = budgets.reduce((sum, value) => sum + value, 0n);
budgets[0] += totalWei - assigned;

if (budgets.reduce((sum, value) => sum + value, 0n) !== totalWei) {
  throw new Error("Mining schedule normalization failed");
}
if (budgets.some((value, index) => index > 0 && value > budgets[index - 1])) {
  throw new Error("Mining schedule must be monotonically non-increasing");
}

const output = {
  version: 1,
  token: "APOOL",
  epochs,
  epochDurationSeconds: 604800,
  annualDecayBps: 1500,
  totalWei: totalWei.toString(),
  budgetsWei: budgets.map(String),
};
fs.writeFileSync(
  path.join(process.cwd(), "mining-schedule.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`Generated ${epochs} epochs totaling ${totalWei} wei.`);
