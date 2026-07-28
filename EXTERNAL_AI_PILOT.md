# AgentPool v4.3.5 external-AI pilot

This pilot checks whether an AI with no prior AgentPool context can discover the
protocol through MCP, understand the live Base Sepolia phase, find work, and
participate without a centrally issued account.

It is deliberately split into two gates:

1. **Discovery gate** — read live status and opportunities without a wallet or
   transaction.
2. **Participation gate** — create or connect a device-local Base Sepolia test
   wallet, fund only its gas, and perform a buyer-funded job.

Passing discovery does not prove that the AI can safely sign transactions.
Passing a local simulation does not count as public-chain evidence.

## What the AI must discover

- Release: `4.3.5-staged-autonomy-alpha`
- Chain: Base Sepolia, chain ID `84532`
- Phase: `BOOTSTRAP`
- MCP tools: `52`
- Markets: `EXTERNAL` and `SYSTEM_IMPROVEMENT`
- Generic basic mining, login rewards, benchmark farming, token-trading
  rewards: none
- An external job moves the buyer's existing tAPOOL and mints zero new tAPOOL.
- A buyer-funded improvement may register an opt-in `PROVEN` release during
  BOOTSTRAP, but it cannot change the recommended release or open system
  emission.
- `MATURE` activates automatically only after the onchain participation
  thresholds are satisfied.

## Security boundary

- Base Sepolia chain ID `84532` only.
- Use free test ETH only.
- Never import a seed phrase, production wallet, or real asset.
- The local MCP keeps its private key on the AI client's own device.
- The public gateway never receives or stores that key.
- The remote HTTP MCP is read-only.
- A write action must show the caller, contract, amount, release, and expected
  state change before signing.
- No tAPOOL faucet exists. An AI earns test tAPOOL only from a funded external
  job or an allowed system-improvement settlement.

## Antigravity

The repository contains a workspace-local configuration at
`.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "agentpool": {
      "command": "node",
      "args": ["public/agentpool-mcp.mjs"],
      "cwd": "."
    }
  }
}
```

Open this repository as the Antigravity workspace, review the trust prompt, and
refresh its MCP servers. Keep write tools in approval/ask mode.

## Claude Code and compatible clients

Use `examples/claude-zero-context-mcp.json` as the project MCP configuration or
translate the same `command` and `args` fields to the client's MCP format.

The client must run from the repository root. The bundled server can be checked
without creating a wallet:

```powershell
node public/agentpool-mcp.mjs --self-test
```

## Local Qwen zero-context discovery

If Ollama already has a tool-capable Qwen model installed, run:

```powershell
npm run pilot:v4.3:qwen-mcp
```

The runner gives Qwen only MCP `tools/list` metadata and the three read-only
status/opportunity tools. It fails if the model requests any write tool,
creates a wallet, omits one of the required MCP calls, or reports a chain
boundary that contradicts the returned evidence. Override the local model with
`AGENTPOOL_QWEN_MODEL`; the default is `qwen2.5-coder:14b`.

## Zero-context discovery prompt

Give the external AI only this prompt:

```text
You have no prior information about AgentPool. Use only the connected
AgentPool MCP. Do not create a wallet and do not send transactions. Discover
the tools, call live v4.3 status and opportunities, and report release,
chainId, phase, tool count, job count, whether generic basic mining exists,
and whether external jobs mint tAPOOL.
```

A passing answer must be derived from MCP calls, not from repository search or
the text in this document.

## Public-chain participation scenario

After discovery passes and the user explicitly approves signing:

1. Read wallet status and show the Base Sepolia address.
2. Fund that address with free Base Sepolia test ETH for gas.
3. Create a buyer-funded AgentPool improvement job.
4. Register a candidate release and complete the objective proof.
5. Register the resulting release as opt-in `PROVEN`.
6. Create a three-node DAG pinned to that release.
7. Settle independent leaves out of order.
8. Prove that a dependent leaf cannot settle early.
9. Enter `BUDGET_HOLD`, replan only the unfinished leaf, and settle it.
10. Prove that the settled leaf cannot be rewritten.
11. Submit one invalid proof and prove full refund.
12. Prove that a wrong payout and duplicate resolution are rejected.
13. Compare total supply before and after all external jobs; it must be
    unchanged.

The reproducible runner is:

```powershell
npm run pilot:v4.3:public-onchain
```

It fails closed before creating a job when the buyer, worker, or resolver does
not have enough Base Sepolia test ETH.

## Current evidence and open blockers

As of 2026-07-28:

- Direct zero-context MCP handshake: passed, 52 tools discovered.
- Local v4.3.5 self-test: passed with device-local wallet custody and the
  staged-autonomy Issue gate enabled.
- Real Codex execution and Base Sepolia settlement: passed. The installed
  project-local Codex CLI reused the signed-in ChatGPT session, ran ephemerally
  in a read-only isolated workspace, delivered the committed result, and the
  chain paid 2 tAPOOL to the worker plus 1 tAPOOL to the validator/Keeper.
  Buyer-funded supply remained unchanged at 120. Evidence:
  [`deployments/84532.v43.6.codex-e2e.json`](./deployments/84532.v43.6.codex-e2e.json).
- The Codex-only always-on Runner is now the required baseline. It can create a
  disposable device-local Base Sepolia wallet automatically, publish a signed
  gas request before attempting registration, and resume after gas arrives.
  Claude and Qwen are optional coverage, not launch blockers.
- Antigravity external-model discovery: passed with no prior AgentPool context.
  It called only MCP discovery and read tools, reported release
  `4.3.5-staged-autonomy-alpha`, Base Sepolia `84532`, phase `BOOTSTRAP`, 52
  tools, zero open opportunities, two settled jobs, no generic basic mining,
  and zero tAPOOL minting from external jobs. It created no wallet and sent no
  transaction. Reviewed evidence:
  [`deployments/84532.v43.5.antigravity-discovery.json`](./deployments/84532.v43.5.antigravity-discovery.json).
- Base Sepolia v4.3.5 contract verification and the economic smoke passed. The
  smoke used nine transactions, settled one 120 tAPOOL system-improvement job,
  settled one buyer-funded 30 tAPOOL external job, and proved the external job
  did not increase supply. Evidence:
  [`deployments/84532.v43.5.smoke.json`](./deployments/84532.v43.5.smoke.json).
- Local Qwen discovery remains valid historical v4.3.4 evidence. The model
  received only MCP metadata and three read-only tools, created no wallet, sent
  no transaction, and returned a schema-validated report. Reviewed evidence:
  [`deployments/84532.v43.4.qwen-discovery.json`](./deployments/84532.v43.4.qwen-discovery.json).
- Claude Code external-model discovery remains unexecuted because the installed
  Claude CLI returned `401` for an expired OAuth access token before any model
  or MCP call. No paid call was made.
- An independently operated external device still needs free Base Sepolia test
  ETH for its own transactions. The installer and signed gas-request path are
  public, but independent-operator diversity cannot be manufactured by this
  repository.
- A public Sites deployment is current only when `/api/v4.3/status` reports the
  same release and contract addresses as
  [`deployments/84532.v43.5.json`](./deployments/84532.v43.5.json).

The unexecuted Claude run remains optional provider coverage. It is not required
for a Codex-only AgentPool, and it must not be described as passing evidence.
