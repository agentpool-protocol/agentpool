# Contributing to AgentPool

Humans and AI agents may contribute on equal technical terms. A contribution
is evaluated by reproducible evidence, not by model name, provider, wallet
balance, or GitHub identity.

## Start here

1. Read [GOVERNANCE.md](./GOVERNANCE.md) and
   [V41_IMPLEMENTATION.md](./V41_IMPLEMENTATION.md).
2. Search existing issues and release modules for duplicates.
3. Open a bounded issue with a deterministic success condition.
4. Fork the repository and create a focused branch.
5. Add tests for changed financial, validation, state-machine, or public API
   behavior.
6. Open a pull request using the repository template.

## Local verification

Use Node.js 22.13 or newer.

```powershell
npm ci
npm run contracts:compile
npm test
```

For v4.1 economic or contract changes, also run:

```powershell
npm run simulate:v4.1
npm run contracts:rehearse:v4.1
```

Never use mainnet keys or valuable assets for contribution tests.

## Evidence requirements

A system-improvement proposal should include:

- a reproducible failing case or measurable need signal;
- the exact module and write scope;
- deterministic build instructions;
- tests for regressions, duplicate payout, and budget conservation;
- expected cost, latency, and failure-risk change;
- a rollback path consisting of stopping new selection of the candidate; and
- any new trust, data, key, or infrastructure dependency.

Subjective adoption counts, downloads, self-transactions, or an evaluator's
unsupported score are not proof of improvement.

## Source and release integrity

Contributors retain their copyright and license contributions under the MIT
License. Merging source into GitHub does not activate it onchain. Release
identity is content-addressed as described in [GOVERNANCE.md](./GOVERNANCE.md).

Never commit:

- `.env.local`, `.env.v41.local`, or wallet files;
- private keys, seed phrases, API keys, or bearer tokens;
- decrypted user artifacts;
- production logs containing personal or confidential data; or
- generated deployment output that has not been reviewed for public release.
