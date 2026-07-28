# AgentPool v4.3.7 Autonomous Validation Matrix

This matrix separates deterministic failures from external testnet blockers.
`BLOCKED` is allowed only when completion requires an external signature,
faucet, or unavailable network service. It must never hide a code failure.

## Environments

| Environment | Purpose | State changes |
|---|---|---|
| Node test runner | Unit, integration, MCP, runner, and API behavior | Local files only |
| In-memory EVM | Contract and economic adversarial rehearsal | Disposable local chain |
| Solidity compiler | Reproducible contract artifacts | Local artifacts |
| Base Sepolia reader | Deployed bytecode and accounting verification | Read-only |
| Public Sites reader | Production status, discovery, and MCP bundle | Read-only |
| Base Sepolia pilot | Same-AI role completion and tAPOOL settlement | Testnet only; separately gated |

## Required checks

| ID | Area | Acceptance condition | Evidence |
|---|---|---|---|
| UNIT-01 | Repository regression | Every Node test passes | `npm test` |
| GAS-01 | Gas estimate safety | Gas limit is rounded up by 25% | `tests/evm-gas.test.mjs` |
| GAS-02 | Fee cap safety | Missing caps preserve discovery; malformed caps fail closed | `tests/evm-gas.test.mjs` |
| LINT-01 | Static quality | ESLint exits successfully | `npm run lint` |
| BUILD-01 | Production build | Every public route and bundle builds | `npm run build` |
| SOL-01 | Contract compilation | All Solidity contracts compile with no error | `npm run contracts:compile` |
| ECON-01 | v4.3 economy | External work mints zero and system work obeys bounded issuance | `npm run contracts:rehearse:v4.3:public` |
| BOOT-01 | Dynamic role payout | One AI receives the sum of distinct accepted role quotes | `npm run contracts:rehearse:v4.3.7` |
| BOOT-02 | Mandatory role order | Implementation cannot skip reproduction | v4.3.7 rehearsal |
| BOOT-03 | Replay protection | Delivery and receipt reuse are rejected | v4.3.7 rehearsal |
| BOOT-04 | Quote caps | Item, Issue, daily, and lifetime limits cannot be exceeded | v4.3.7 rehearsal |
| BOOT-05 | Finite graduation | Graduation is one-way and does not strand reserved work | v4.3.7 rehearsal |
| MCP-01 | Zero-context discovery | MCP handshake exposes required v4.3.7 tools | `npm run mcp:self-test:v4.3` and Node tests |
| MCP-02 | Unknown-agent recovery | Error is structured and points to registration | `tests/mcp.test.mjs` |
| MCP-03 | Device-local custody | MCP does not create or upload a wallet during discovery | `tests/mcp.test.mjs` |
| CHAIN-01 | Deployment identity | Base Sepolia code, token, gates, verifier, and finance hash match the manifest | `npm run contracts:verify:v4.3.7` |
| CHAIN-02 | Pool accounting | `available + reserved + paid = funded` | live status and MCP tests |
| WEB-01 | Public explorer | Homepage and `/api/v4.3/status` return HTTP 200 | public read check |
| WEB-02 | Public MCP | Downloadable v4.3.7 MCP returns HTTP 200 and contains required tools | public read check |
| SEC-01 | Runtime dependencies | High and critical production vulnerabilities equal zero | `npm audit --omit=dev --audit-level=high` |
| LIVE-01 | Same-AI live payout | Reproducer, implementer, and validator receipts settle 1.5 tAPOOL exactly once | Base Sepolia pilot |

## Status rules

- `PASS`: acceptance condition is directly evidenced.
- `FAIL`: code, contract, accounting, or build behavior violates the condition.
- `BLOCKED`: code path is ready but an external signature, testnet gas source, or
  unavailable service prevents execution.
- A failed command is fixed and rerun before the final report whenever the
  failure is within this repository.
- Base mainnet, real ETH, and real-value APOOL are excluded.
