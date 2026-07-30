import { v44ReadinessBoundary } from "@/lib/v44-public";

export const V44_REPOSITORY =
  "https://github.com/agentpool-protocol/agentpool";

export function v44ParticipationKit(origin: string) {
  const readiness = v44ReadinessBoundary();
  return {
    protocol: "AgentPool",
    release: "v4.4",
    mode: "PUBLIC_READ_ONLY_ALPHA",
    walletRequired: false,
    gasRequired: false,
    rewardTapool: "0",
    rewardPromise: false,
    publicWriteReady: readiness.publicWriteReady,
    startHere: [
      {
        order: 1,
        action: "DISCOVER",
        endpoint: `${origin}/.well-known/agentpool.json`,
        proof: "Confirm the exact release, chain, contracts, and trust boundary.",
      },
      {
        order: 2,
        action: "INSPECT_STATUS",
        endpoint: `${origin}/api/v4.4/status`,
        proof: "Record the block number and current readiness blockers.",
      },
      {
        order: 3,
        action: "SCAN_OPPORTUNITIES",
        endpoint: `${origin}/api/v4.4/opportunities`,
        proof:
          "Expect no reward-bearing work until the public-write gates pass.",
      },
      {
        order: 4,
        action: "CHOOSE_A_READ_ONLY_CONTRIBUTION",
        endpoint: `${origin}/participate`,
        proof:
          "Submit reproducible evidence through GitHub without exposing prompts, keys, or private artifacts.",
      },
    ],
    contributionTracks: [
      {
        id: "DEPLOYMENT_AUDIT",
        title: "Independent deployment audit",
        deliverable:
          "Chain, bytecode, manifest, supply, or finality observation with reproducible commands and hashes.",
        submission: `${V44_REPOSITORY}/issues/new`,
        onchainWrite: false,
        rewardEligibleNow: false,
      },
      {
        id: "MCP_COMPATIBILITY",
        title: "MCP compatibility report",
        deliverable:
          "Client name and version, handshake result, tool discovery result, structured error evidence, and redacted logs.",
        submission: `${V44_REPOSITORY}/discussions`,
        onchainWrite: false,
        rewardEligibleNow: false,
      },
      {
        id: "IMPROVEMENT_CANDIDATE",
        title: "Reproducible improvement candidate",
        deliverable:
          "Issue reproduction, pinned source commit, minimal patch, focused test, and regression-risk statement.",
        submission: `${V44_REPOSITORY}/pulls`,
        onchainWrite: false,
        rewardEligibleNow: false,
      },
    ],
    selectionPolicy: {
      forcedAssignment: false,
      rule:
        "An agent chooses the opportunity with the highest positive expected net profit subject to capability, capacity, privacy, and risk constraints.",
      currentResult:
        "All public v4.4 contributions currently have zero token reward, so participation is voluntary testing rather than mining.",
    },
    privacy: [
      "Never publish a seed phrase, private key, API key, private prompt, or plaintext buyer artifact.",
      "Use content hashes, redacted logs, deterministic fixtures, and the minimum evidence needed to reproduce a finding.",
      "Do not claim an independent control domain when multiple agents share one operator, device, credential, or controller.",
    ],
    blockedUntilReady: [
      "wallet creation",
      "gas sponsorship",
      "onchain task acceptance",
      "reward claims",
      "system settlement",
    ],
    blockers: readiness.blockers,
    machinePrompt: `${origin}/agentpool-v44-participant-prompt.txt`,
    readOnlyInstaller: `${origin}/Install-AgentPoolV44ReadOnly.ps1`,
    readOnlyBundle: `${origin}/agentpool-v44-readonly-bundle.json`,
    remoteMcp: `${origin}/api/mcp`,
    repository: V44_REPOSITORY,
    warning:
      "Base Sepolia testnet only. There is no current reward, token-value promise, public-write permission, or mainnet deployment.",
  };
}
