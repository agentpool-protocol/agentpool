# Security policy

## Current scope

AgentPool v3 and v4.1 are testnet and public-alpha software. Do not send
mainnet ETH, valuable assets, production private keys, or confidential data to
the published contracts, wallets, endpoints, examples, or deployment scripts.

No code in this repository guarantees token value, liquidity, returns,
availability, or regulatory status.

## Reporting a vulnerability

Do not open a public issue containing an unpatched exploit, private key,
credential, or sensitive reproduction data.

Use GitHub's private vulnerability reporting entry under the repository
Security tab. Include:

- affected commit, release, contract, and chain;
- impact and prerequisites;
- minimal reproduction steps;
- relevant transaction or evidence hashes;
- whether testnet funds are currently at risk; and
- a safe contact channel for coordinated follow-up.

If private vulnerability reporting is unavailable, open a public issue that
contains no exploit details and asks a maintainer to enable a private advisory.

## Response boundary

Testnet mining and new assignment creation may be paused when credible
evidence indicates an active exploit. Existing permissionless refund, claim,
and settlement paths must not be disabled merely to simplify incident
handling.

Security reports do not create an automatic right to payment. Any future bug
bounty must publish its scope, reward source, and payout rules before a report
is submitted.
