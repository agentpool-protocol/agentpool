import fs from "node:fs";
import path from "node:path";
import {
  AgentPoolV43Engine,
  digest,
} from "../protocol/autonomy/agentpool-v43-engine.mjs";
import {
  AgentPoolV43ReferenceSwarm,
  createReferencePolicy,
} from "../protocol/autonomy/reference-swarm.mjs";

const root = process.cwd();
const engine = new AgentPoolV43Engine();
const definitions = [
  {
    id: "planner",
    group: "planning-lab",
    roles: ["PLANNER"],
    tracks: ["planning", "code"],
    price: 100,
  },
  {
    id: "worker-light",
    group: "runtime-light",
    roles: ["WORKER"],
    tracks: ["code"],
    price: 220,
    success: 8_700,
  },
  {
    id: "worker-ultra",
    group: "runtime-ultra",
    roles: ["WORKER"],
    tracks: ["code"],
    price: 450,
    success: 9_900,
  },
  ...["a", "b", "c"].map((suffix, index) => ({
    id: `validator-${suffix}`,
    group: `validation-${suffix}`,
    roles: ["VALIDATOR"],
    tracks: ["validation"],
    price: 40 + index * 5,
    success: 9_700 - index * 100,
  })),
  ...["a", "b", "c"].map((suffix) => ({
    id: `pricer-${suffix}`,
    group: `pricing-${suffix}`,
    roles: ["PRICER"],
    tracks: ["pricing"],
    price: 10,
    success: 9_500,
  })),
];

for (const definition of definitions) {
  engine.registerAgent({
    id: definition.id,
    address: `local:${definition.id}`,
    operatorGroup: definition.group,
    runtimeHash: digest({ runtime: definition.id }),
    capacity: 3,
    capabilities: definition.tracks.map((track) => ({
      track,
      successLowerBps: definition.success ?? 9_500,
      p95LatencyMs: definition.id.includes("ultra") ? 800 : 500,
      costFloor: definition.price,
    })),
  });
}

const policies = definitions.map((definition) =>
  createReferencePolicy({
    agentId: definition.id,
    roles: definition.roles,
    capabilities: definition.tracks.filter(
      (track) => !["planning", "pricing", "validation"].includes(track),
    ),
    price: definition.price,
  }),
);
const swarm = new AgentPoolV43ReferenceSwarm(engine, policies);

engine.publishOpportunity({
  id: "pilot-system-improvement",
  kind: "SYSTEM_IMPROVEMENT",
  creator: "watcher-ai",
  specificationHash: digest("repair-autonomous-router"),
  maxBudget: 1_000,
  minScoreBps: 8_000,
  deadline: 100,
  systemEmissionCap: 1_000,
});
const systemResult = await swarm.runOpportunity("pilot-system-improvement");

engine.publishOpportunity({
  id: "pilot-external-job",
  kind: "EXTERNAL",
  creator: "buyer-ai",
  specificationHash: digest("buyer-requested-code"),
  maxBudget: 1_000,
  minScoreBps: 8_000,
  deadline: 100,
  externalDeposit: 1_000,
});
const externalResult = await swarm.runOpportunity("pilot-external-job");

engine.assertConservation("pilot-system-improvement");
engine.assertConservation("pilot-external-job");
const output = {
  schemaVersion: 1,
  release: "4.3.0-autonomous-alpha",
  systemResult,
  externalResult,
  selectedSystemWorker:
    engine.opportunity("pilot-system-improvement").tasks[0].allocation.worker
      .agentId,
  systemMinted:
    engine.opportunity("pilot-system-improvement").minted,
  externalMinted:
    engine.opportunity("pilot-external-job").minted,
  externalRefunded:
    engine.opportunity("pilot-external-job").refunded,
  events: {
    system: engine.opportunity("pilot-system-improvement").history,
    external: engine.opportunity("pilot-external-job").history,
  },
  passed:
    systemResult.total > 0 &&
    externalResult.total > 0 &&
    engine.opportunity("pilot-external-job").minted === 0,
};
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "outputs", "v43-autonomous-pilot.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(output)}\n`);
