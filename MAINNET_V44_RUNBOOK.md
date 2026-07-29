# AgentPool v4.4 Base mainnet candidate

This runbook prepares an ownerless Base mainnet release. It does not authorize
or perform a mainnet deployment. Base Sepolia v4.3 remains the public testnet
and must not be overwritten.

## Candidate properties

- Token: `AgentPool` / `APOOL`
- Maximum supply: 1,000,000,000,000 APOOL
- Decimals: 18
- Premint: 0
- Core lane: at most 63,000 APOOL per week and 900 billion lifetime
- Evolution lane: at most 7,000 APOOL per week and 100 billion lifetime
- External buyer jobs: existing buyer APOOL only; no emission
- Administrator, proxy upgrade, emergency withdrawal, and arbitrary mint: none
- Temporary deployment authorities: removed during one-time wiring and checked
  again by the independent verifier

The deployer receives no APOOL and has no runtime role after wiring. The
evidence gates are release checks, not governance powers.

## Build and local proof

Run from a clean, committed checkout:

```powershell
npm ci
npm run contracts:compile
npm run evidence:v4.4:source
npm run evidence:v4.4:source:verify
npm run contracts:rehearse:v4.4:mainnet
npm run contracts:rehearse:v4.4:full
npm test
```

The source-evidence pair binds the exact Git commit and tree, Solidity source
blob IDs, compiler version and settings, package lock, configuration, finance
invariant, and creation/runtime bytecode hashes. Verification recomputes the
whole report and rejects any changed field.

The focused rehearsal proves zero premint, minter isolation, pre-genesis
closure, weekly and lifetime cap enforcement, reservation release, and
unauthorized-call rejection. It also runs 32 deterministic stateful
reserve/partial-settle/release sequences and checks reservation, emission, and
supply conservation after every case. The full rehearsal runs the current
immutable finance kernel through BOOTSTRAP, TRANSITION, and MATURE with the
v4.4 APOOL token.

## Evidence gates

`mainnet-v44-gates.json` is intentionally committed with every gate blocked.
Changing a gate to `approved` requires a 64-character SHA-256 digest of the
actual evidence. The same digest must be supplied independently in
`.env.v44.mainnet.local`.

Required evidence:

1. Reproducible final source, compiler, artifact, and source-commit report.
2. Independent security review of the exact deployment bytecode and economic
   invariants.
3. Public testnet reliability report with no unresolved fund conservation,
   duplicate payout, cap bypass, or refund-liveness failure.
4. Evidence that the three bootstrap validators represent distinct operational
   groups.
5. Independent review of emission, escrow, reservation, and consensus
   invariants.
6. The actual deployer's own legal assessment for the jurisdictions and
   conduct it introduces. This creates no AgentPool operator or runtime owner.
7. AgentPool/APOOL name and symbol clearance.

The script refuses deployment if one gate is blocked, a digest differs, the
tracked worktree is dirty, or `V44_SOURCE_COMMIT` is not the current `HEAD`.

## Mainnet inputs

Copy `.env.v44.mainnet.example` to `.env.v44.mainnet.local`. Keep the private
key only in that ignored local file or an equivalent secret-injection system.

The deployment address, bootstrap proposer, and three validators must be five
different addresses. Each validator must also carry a different non-zero
operator-group identifier. The bootstrap issue, specification, delivery,
objective proof, module, and manifest are supplied as content-addressed
evidence rather than hardcoded test fixtures.

The genesis timestamp must be 72 hours to 30 days in the future. This gives
independent observers time to verify the deployed bytecode before any emission
can begin.

The epoch vault enforces that observation window onchain. Before
`genesisStart`, both emission reservation and settlement revert with
`EmissionNotStarted`; neither the bootstrap proposer nor the TaskMarket can
bypass it. Buyer-funded external jobs may exist during the window, but the
Core and Evolution vaults cannot mint APOOL.

## Deployment sequence

```powershell
npm run contracts:preflight:v4.4:mainnet
npm run contracts:deploy:v4.4:mainnet
npm run contracts:verify:v4.4:mainnet
```

Preflight performs no write. Deployment refuses to overwrite an existing
manifest and saves a partial manifest after every transaction so interrupted
work can only resume with the same deployer, source commit, configuration,
gates, genesis, and release identity.

The final verifier checks:

- Base chain ID 8453
- code at every manifest address and recorded deployed code hashes
- removal of every temporary authority
- exact token name, symbol, decimals, supply cap, and two minters
- exact vault lanes, weekly/lifetime caps, genesis, and TaskMarket
- total supply equals Core plus Evolution vault emissions
- external escrow, registries, router, Issue gate, and consensus wiring
- finance invariant and bootstrap roots
- success receipt for every deployment transaction

Do not announce APOOL as live until the independent verification report passes
against the public Base mainnet RPC and the manifest is committed.
