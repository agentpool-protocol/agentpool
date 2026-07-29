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
npm run security:slither:v4.4
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

The maintainer Slither pass and its unresolved trust-boundary questions are
recorded in [audits/V44_SLITHER_TRIAGE.md](./audits/V44_SLITHER_TRIAGE.md).
It is not an independent audit. Give
[audits/V44_GPT_REVIEW_PACKET.md](./audits/V44_GPT_REVIEW_PACKET.md) to an
external GPT or human reviewer so they inspect the exact source and return
reproducible findings rather than relying on the maintainer's conclusions.

## Evidence gates

`mainnet-v44-gates.json` is an intentionally blocked, tracked template. Never
put approvals into that file: doing so would change the source commit after its
reproducibility hash was calculated. Copy it to the ignored
`.mainnet-v44-gates.local.json`, set `V44_GATES_FILE` to that path, and change a
gate to `approved` only after recording the 64-character SHA-256 digest of the
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

The script refuses deployment if the local gate file is missing, one gate is
blocked, a digest differs, the tracked worktree is dirty, or
`V44_SOURCE_COMMIT` is not the current `HEAD`. Because the approval file is
ignored, approving evidence cannot mutate the source commit it attests.

## Mainnet inputs

Copy `.env.v44.mainnet.example` to `.env.v44.mainnet.local`. Keep the private
key only in that ignored local file or an equivalent secret-injection system.

The deployment address, bootstrap proposer, and three validators must be five
different addresses. Each validator must also carry a different non-zero
operator-group identifier. The bootstrap issue, module, and manifest are
content-addressed evidence rather than hardcoded test fixtures.

BOOTSTRAP objectives are supplied in the ignored
`.mainnet-v44-bootstrap-objectives.local.json` file using
`mainnet-v44-bootstrap-objectives.template.json` as the schema reference. The
launch catalog must contain 24-32 distinct AgentPool improvement or
verification objectives. Each entry pins capability, specification, delivery,
objective proof, and bounded Work Power units. Set
`V44_BOOTSTRAP_OBJECTIVES_SHA256` to the exact file digest. Twenty successful
settlements are required for
TRANSITION and at least four unused objectives provide bounded recovery
capacity without minting unless they are actually completed. A changed,
duplicated, undersized, oversized, or over-capacity catalog fails preflight.
The single-candidate bootstrap job may contain those independent milestones
and settle them across at least two epochs with at least three agents and two
operator groups. There is no administrator bypass if those conditions are not
met. A system replan may replace only unfinished catalog objectives and may
not extend their original deadlines; additional time requires a newly admitted
Issue.

`deliveryHash` and `objectiveProofHex` are challenge answers. Keep the local
catalog private until the corresponding objective settles. The committed
deployment manifest contains only their commitments, objective leaves, and
Merkle paths; it must never publish either answer field. The interrupted
deployment journal is ignored by Git and is deleted after a successful
deployment. Every `objectiveProofHex` must contain at least 32 bytes of
unpredictable challenge evidence so the public commitment cannot be brute
forced. Completed objective evidence may be published separately after
settlement for independent replay.

System-improvement evidence also binds the release artifact itself. The
settled delivery commitment covers the module hash, manifest hash, and all
canary metrics; the worker cannot attach different performance claims later.
Recommendation adoption is counted only from a settled job whose pinned
`releaseId` is the proposed release, so unrelated completed work cannot
manufacture adoption.

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
manifest and journals the nonce plus exact input hash before every broadcast.
Interrupted work can only resume with the same deployer, source commit,
configuration, objective catalog, gates, genesis, and release identity. An
intent without a known transaction hash stops for manual reconciliation
instead of risking a duplicate deployment.

If the transaction is visible on BaseScan but the local journal stopped before
recording its hash, do not edit the journal. Put the exact intent key printed
by the deployment error and the transaction hash in the current PowerShell
session, run the reconciliation command, then resume:

```powershell
$env:V44_RECONCILE_INTENT_KEY = "deploy:token"
$env:V44_RECONCILE_TX_HASH = "0x..."
npm run contracts:reconcile:v4.4:mainnet
npm run contracts:deploy:v4.4:mainnet
```

The reconciliation command performs no transaction. It accepts the hash only
when the Base chain, sender, nonce, destination, and exact calldata hash match
the pre-broadcast journal.

The final verifier checks:

- Base chain ID 8453
- exact creation transaction, sender, nonce, constructor arguments, current
  artifact bytecode, contract address, and deployed code at every address
- exact one-time configuration calldata and sender
- removal of every temporary authority
- exact token name, symbol, decimals, supply cap, and two minters
- exact vault lanes, weekly/lifetime caps, genesis, and TaskMarket
- total supply equals Core plus Evolution vault emissions
- external escrow, registries, router, Issue gate, and consensus wiring
- finance invariant, complete bootstrap objective catalog, and Merkle roots
- success receipt for every deployment transaction

Do not announce APOOL as live until the independent verification report passes
against the public Base mainnet RPC and the manifest is committed.
