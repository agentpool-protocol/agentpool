#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  V44_TESTNET_CHAIN_ID,
  buildV44BootstrapDelivery,
  createV44TestWallet,
  createV44TestnetParticipant,
} from "../scripts/lib/v44-testnet-participant.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const participant = createV44TestnetParticipant({ root: ROOT });
const HASH = /^0x[a-fA-F0-9]{64}$/u;

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const server = new McpServer(
  { name: "agentpool-v44-testnet-participant", version: "1.0.0" },
  {
    instructions:
      "Base Sepolia-only local-wallet bridge for AgentPool v4.4. Never use real assets. Read opportunities, compare expected net profit, and write only with the device-local test wallet. The remote AgentPool MCP remains read-only and never receives this key.",
  },
);

server.registerTool(
  "agentpool_v44_testnet_status",
  {
    title: "Read the exact v4.4 Base Sepolia campaign",
    description:
      "Verifies chain 84532 and reports the pinned deployment, local wallet, registration, supply, emission, and time until the bounded bootstrap lane starts.",
    inputSchema: {},
  },
  async () => result(await participant.status()),
);

server.registerTool(
  "agentpool_v44_testnet_opportunities",
  {
    title: "Discover assigned v4.4 onchain work",
    description:
      "Reads JobCreated events from the pinned campaign and returns only milestones assigned to this local wallet. No result is fabricated when no job is open.",
    inputSchema: {},
  },
  async () =>
    result({
      campaignId: participant.manifest.campaignId,
      address: participant.account?.address ?? null,
      opportunities: await participant.opportunities(),
    }),
);

server.registerTool(
  "agentpool_v44_create_test_wallet",
  {
    title: "Create a device-local Base Sepolia wallet",
    description:
      "Creates a valueless testnet-only wallet after explicit confirmation. The private key is never printed or uploaded.",
    inputSchema: { confirmTestnetOnly: z.literal(true) },
  },
  async () =>
    result({
      ...createV44TestWallet(),
      chainId: V44_TESTNET_CHAIN_ID,
      testnetOnly: true,
      warning: "Never send Base mainnet ETH or any valuable asset to this wallet.",
    }),
);

server.registerTool(
  "agentpool_v44_register_onchain",
  {
    title: "Register this v4.4 execution identity",
    description:
      "Registers one immutable runtime identity and self-declared operator group on the isolated Base Sepolia campaign.",
    inputSchema: {
      operatorGroup: z.string().min(1).max(128),
      runtime: z.string().min(1).max(256),
    },
  },
  async ({ operatorGroup, runtime }) => {
    const status = await participant.status();
    if (status.registered) {
      return result({
        alreadyRegistered: true,
        address: status.address,
        operatorGroup: status.operatorGroup,
        runtimeHash: status.runtimeHash,
      });
    }
    return result(await participant.register(operatorGroup, runtime));
  },
);

server.registerTool(
  "agentpool_v44_publish_bootstrap_capacity",
  {
    title: "Publish capacity for the exact bootstrap audits",
    description:
      "Publishes capacity for every distinct committed capability in this campaign. It does not mint or reserve APOOL.",
    inputSchema: {
      runtime: z.string().min(1).max(256),
      capacityPerCapability: z.number().int().min(100).max(10_000).default(100),
    },
  },
  async ({ runtime, capacityPerCapability }) => {
    const capabilities = [
      ...new Set(
        participant.manifest.bootstrap.objectives.map(
          (objective) => objective.capabilityHash,
        ),
      ),
    ];
    const receipts = [];
    for (const capability of capabilities) {
      receipts.push({
        capability,
        ...(await participant.publishCapacity(
          capability,
          capacityPerCapability,
          Number(participant.manifest.bootstrap.issue.expiresAt),
          runtime,
        )),
      });
    }
    return result({ capabilities: capabilities.length, receipts });
  },
);

server.registerTool(
  "agentpool_v44_build_bootstrap_delivery",
  {
    title: "Reproduce one committed bootstrap audit result",
    description:
      "Reads the pinned source evidence through the public specification, constructs canonical evidence, and rejects any delivery hash that differs from the deployment commitment. This is read-only.",
    inputSchema: {
      objectiveIndex: z.number().int().min(0).max(31),
    },
  },
  async ({ objectiveIndex }) => {
    const delivery = buildV44BootstrapDelivery({
      manifest: participant.manifest,
      publicEvidence: participant.publicEvidence,
      objectiveIndex,
    });
    return result(delivery);
  },
);

server.registerTool(
  "agentpool_v44_accept_milestone_onchain",
  {
    title: "Accept an assigned v4.4 milestone",
    description:
      "Accepts only a milestone whose precommitted worker is this local wallet and atomically reserves its published capacity.",
    inputSchema: {
      jobId: z.string().regex(HASH),
      milestone: z.number().int().min(0).max(31),
    },
  },
  async ({ jobId, milestone }) => result(await participant.accept(jobId, milestone)),
);

server.registerTool(
  "agentpool_v44_deliver_bootstrap_milestone_onchain",
  {
    title: "Deliver an exact-source v4.4 audit milestone",
    description:
      "Reconstructs the public canonical artifact, checks its deployment commitment, then submits only the delivery hash on Base Sepolia.",
    inputSchema: {
      jobId: z.string().regex(HASH),
      milestone: z.number().int().min(0).max(31),
      objectiveIndex: z.number().int().min(0).max(31),
    },
  },
  async ({ jobId, milestone, objectiveIndex }) => {
    if (milestone !== objectiveIndex) {
      throw new Error("V44_PARTICIPANT_OBJECTIVE_MILESTONE_MISMATCH");
    }
    const delivery = participant.buildDelivery(objectiveIndex);
    return result({
      objectiveId: delivery.specification.id,
      deliveryHash: delivery.deliveryHash,
      artifact: delivery.artifact,
      ...(await participant.deliver(jobId, milestone, delivery.deliveryHash)),
    });
  },
);

server.registerTool(
  "agentpool_v44_commit_evaluation_onchain",
  {
    title: "Commit one evidence-backed validator score",
    description:
      "Uses the deployment-fixed validator Merkle proof. The tool has no payout or recipient input.",
    inputSchema: {
      jobId: z.string().regex(HASH),
      milestone: z.number().int().min(0).max(31),
      scoreBps: z.number().int().min(0).max(10_000),
      evidence: z.string().min(1),
      salt: z.string().min(1),
    },
  },
  async ({ jobId, milestone, scoreBps, evidence, salt }) => {
    const validator = participant.manifest.bootstrap.validators.find(
      (entry) =>
        entry.address.toLowerCase() === participant.account?.address.toLowerCase(),
    );
    if (!validator) throw new Error("V44_PARTICIPANT_NOT_BOOTSTRAP_VALIDATOR");
    return result(
      await participant.commitEvaluation({
        jobId,
        milestone,
        scoreBps,
        evidence,
        salt,
        proof: validator.proof,
      }),
    );
  },
);

server.registerTool(
  "agentpool_v44_reveal_evaluation_onchain",
  {
    title: "Reveal a committed validator score",
    description:
      "Reveals the exact score, evidence, and salt after the commit window. It cannot change recipients or payout amounts.",
    inputSchema: {
      jobId: z.string().regex(HASH),
      milestone: z.number().int().min(0).max(31),
      scoreBps: z.number().int().min(0).max(10_000),
      evidence: z.string().min(1),
      salt: z.string().min(1),
    },
  },
  async (args) => result(await participant.revealEvaluation(args)),
);

server.registerTool(
  "agentpool_v44_refund_expired_onchain",
  {
    title: "Release an expired v4.4 milestone",
    description:
      "Permissionlessly releases an expired reservation after the immutable grace period. It cannot redirect funds.",
    inputSchema: {
      jobId: z.string().regex(HASH),
      milestone: z.number().int().min(0).max(31),
    },
  },
  async ({ jobId, milestone }) =>
    result(await participant.refundExpired(jobId, milestone)),
);

if (process.argv.includes("--self-test")) {
  const status = await participant.status();
  process.stdout.write(
    `${JSON.stringify({ ok: true, toolCount: 11, status }, null, 2)}\n`,
  );
} else {
  await server.connect(new StdioServerTransport());
}
