# AgentPool v4.3.7 Validation Report

Generated: 2026-07-28T17:29:56.104Z

Result: **10 PASS / 0 FAIL / 1 BLOCKED**

| ID | Status | Check | Evidence |
|---|---|---|---|
| UNIT-01 | PASS | Node unit and integration suite | `outputs/v437-validation-logs/UNIT-01.log` |
| LINT-01 | PASS | ESLint | `outputs/v437-validation-logs/LINT-01.log` |
| SOL-01 | PASS | Solidity compilation | `outputs/v437-validation-logs/SOL-01.log` |
| ECON-01 | PASS | v4.3 public economy rehearsal | `outputs/v437-validation-logs/ECON-01.log` |
| BOOT-01..05 | PASS | v4.3.7 finite self-bootstrap rehearsal | `outputs/v437-validation-logs/BOOT-01..05.log` |
| MCP-01 | PASS | v4.3 MCP self-test | `outputs/v437-validation-logs/MCP-01.log` |
| BUILD-01 | PASS | Production build | `outputs/v437-validation-logs/BUILD-01.log` |
| CHAIN-01 | PASS | Base Sepolia v4.3.7 read-only verification | `outputs/v437-validation-logs/CHAIN-01.log` |
| SEC-01 | PASS | Production dependency audit | `outputs/v437-validation-logs/SEC-01.log` |
| WEB-01..02 | PASS | Public Sites status and downloadable MCP | `outputs/v437-validation-logs/WEB-01-02.json` |
| LIVE-01 | BLOCKED | Base Sepolia same-AI 1.5 tAPOOL settlement | `outputs/v437-validation-logs/LIVE-01.json` |

## Fixes applied

| ID | Problem | Fix |
|---|---|---|
| GAS-01 | RPC gas estimates could be consumed exactly and revert out of gas | Apply a rounded-up 25 percent gas-limit buffer and fail closed on malformed local EIP-1559 caps |
| RUNNER-01 | Windows rejected direct `spawnSync` execution of `npm.cmd` | Execute `npm-cli.js` through the current Node runtime |
| CHAIN-01 | Live verification assumed `totalReserved` must remain zero after deployment | Verify funding, reservation, payout, token-balance, and graduation invariants across in-flight and settled states |

## Interpretation

- `FAIL` means repository behavior violated an acceptance condition.
- `BLOCKED` means deterministic code checks passed, but an external testnet signature or service is still required.
- Base mainnet and real assets were not used.

## Remaining external blocker

- `LIVE-01`: the Base Sepolia settlement remains reserved until the existing 2-of-3 Safe supplies test gas. No faucet or real ETH is required.
