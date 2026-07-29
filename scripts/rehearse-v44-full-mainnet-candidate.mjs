process.env.AGENTPOOL_REHEARSAL_TOKEN_ARTIFACT = "AgentPoolV44Token";
process.env.AGENTPOOL_REHEARSAL_OUTPUT =
  "v44-full-mainnet-candidate-rehearsal.json";

await import("./rehearse-v43-public-testnet.mjs");
