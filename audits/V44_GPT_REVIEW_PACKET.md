# AgentPool v4.4 External GPT Review Packet

Use this packet with ChatGPT, Codex, Claude, or another independent reviewer.
It is designed to produce actionable security findings, not an approval based
on the project author's claims.

Repository: `https://github.com/agentpool-protocol/agentpool`

Current review branch and pull request:

- branch: `codex/v43-public-mcp-e2e`
- pull request: `https://github.com/agentpool-protocol/agentpool/pull/19`

The reviewer must record the exact commit they inspected. Branch names and
pull-request heads can move.

## Reviewer prompt

```text
You are an adversarial smart-contract and protocol reviewer. Review AgentPool
v4.4 as a mainnet candidate, but do not approve it merely because tests pass or
the maintainer says a detector warning is a false positive.

Repository:
https://github.com/agentpool-protocol/agentpool

Pull request:
https://github.com/agentpool-protocol/agentpool/pull/19

First record:
- git rev-parse HEAD
- git rev-parse HEAD:contracts
- sha256(outputs/v44-source-reproducibility.json)
- solc version and compiler settings

Primary deployed contract map is CONTRACT_TYPES in
scripts/lib/v44-mainnet.mjs. Start from the deployment script and trace every
constructor/configuration transaction. Review the contracts, deployment
journal, reconciliation script, verification script, release evidence, and
both mainnet rehearsals.

Assume any buyer, worker, verifier, keeper, issue proposer, candidate author,
validator, RPC endpoint, or relayer can be malicious. Also test collusion,
Sybil operator groups, malicious callbacks, uncertain broadcasts, process
crashes, stale RPC reads, and reorg-like receipt disappearance.

Do not propose generic best practices without an executable failure path.
For each finding, provide:
findingId, severity, confidence, status, file, line, exploitPrerequisites,
transactionSequence, invariantViolated, impact, recommendation, and a minimal
regression test.

Pay special attention to:
1. any path that mints or reserves WorkReserve emission without an objective
   proof and approved issue;
2. user escrow pulling from a wallet other than the job creator;
3. payout recipients or amounts being changed after job creation;
4. reentrancy or callback paths that duplicate settlement, refund, adoption,
   contribution, capacity release, or token minting;
5. invalid proof being used to slash or reject another worker;
6. replanning weakening a verifier policy, deadline, objective, or payout;
7. a candidate attesting unrelated module, manifest, delivery, or canary data;
8. an adoption receipt claiming a release the settled job did not execute;
9. governance Work Power inflation through identity, group, epoch, rounding,
   or model/profile changes;
10. deployment resume attaching to the wrong nonce, bytecode, sender, chain,
    or configuration transaction;
11. secret bootstrap answers leaking into public evidence;
12. constructor/configuration addresses not matching the intended immutable
    graph;
13. any owner, proxy, delegatecall, emergency withdrawal, mutable minter, or
    unrestricted pause path;
14. a failure, timeout, validator outage, or indexer outage permanently
    trapping user funds;
15. root reserve exposure exceeding a single bounded epoch.
16. bootstrap work creating binding Work Power or capturing mature governance;
17. the fixed transition committee being replaceable, proposer-controlled, or
    reusable as mature Work Power;
18. Base Sepolia deployment evidence accepting a different graph, source,
    constructor input, verifier codehash, or configuration than mainnet;
19. observation-ledger entries being reusable, hand-written into eligibility,
    or signed before their final body is frozen.

Read audits/V44_SLITHER_TRIAGE.md, but treat it only as the maintainer's
hypothesis. Independently confirm or refute each triage decision.

End with three separate conclusions:
- confirmed exploitable findings;
- unproven concerns requiring dynamic or formal testing;
- release-gate decision for this exact commit.

Do not label the result an independent audit if you are operating from the
project owner's account, prompt, or environment. State that limitation.
```

## Financial invariants

The reviewer should prove, not assume:

```text
external buyer deposit
= external payouts + external refund + still-locked external balance

epoch reservation
= epoch payouts + epoch release + still-open epoch reservation

APOOL total supply
<= immutable maximum supply

all epoch minting
<= weekly cap and lifetime cap

external jobs mint APOOL
= 0
```

The kernel must not infer a payout from an evaluator-selected amount. A
milestone's payout root, total allocation, verifier, objective, release, and
validation policy are pinned before execution.

## Trust-boundary checklist

Review these boundaries individually:

| Boundary | What must be proven |
|---|---|
| buyer to TaskMarket | only creator-approved APOOL is locked |
| TaskMarket to escrow | no arbitrary buyer, recipient, or over-budget spend |
| TaskMarket to epoch vault | objective work cannot exceed reserved emission |
| worker to verifier | delivery cannot choose its own objective or payout |
| verifier to settlement | proof result cannot rewrite recipients or amounts |
| validators to proof registry | no copied reveal, duplicate group, or stale round |
| issue consensus to issue gate | proposal cannot directly unlock reserve funds |
| candidate to release registry | artifact and canary evidence remain bound |
| settled job to adoption | only the executed release receives adoption credit |
| deployer to contract graph | temporary authority is cleared after exact wiring |
| RPC to deployment journal | uncertain sends cannot be silently repeated |
| source to deployed bytecode | compiler inputs and bytecode are reproducible |

## Expected artifacts from the reviewer

The reviewer should return:

1. a machine-readable findings JSON array;
2. a human-readable threat-model report;
3. regression tests for every confirmed issue;
4. the exact reviewed commit and source-evidence SHA-256;
5. a list of paths not reviewed or not reproducible;
6. a release decision of `BLOCK`, `REVIEW_INCOMPLETE`, or
   `NO_CONFIRMED_BLOCKER`.

`NO_CONFIRMED_BLOCKER` is not permission to deploy. The repository's remaining
mainnet gates, including public reliability, validator independence, economic
review, legal deployer assessment, and name/symbol clearance, remain separate.
