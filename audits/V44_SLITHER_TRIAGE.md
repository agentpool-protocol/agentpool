# AgentPool v4.4 Slither Triage

Status: maintainer triage only. This document is not an independent audit and
does not satisfy `mainnet-v44-gates.json`.

## Scope and reproducibility

The review covered every unique Solidity implementation deployed by
`scripts/deploy-v44-base-mainnet.mjs`:

- `AgentPoolV44Token`
- `AgentPoolV43SettlementRouter`
- `AgentPoolV43ReleaseRegistry`
- `AgentPoolV43CapacityRegistry`
- `AgentPoolV43UserEscrowKernel`
- `AgentPoolV43EpochVault`
- `AgentPoolV43ContributionLedger`
- `AgentPoolV432ProofRegistry`
- `AgentPoolV43EvolutionConsensus`
- `AgentPoolV43HashObjectiveVerifier`
- `AgentPoolV435SystemIssueGate`
- `AgentPoolV435TransitionIssueConsensus`
- `AgentPoolV432IssueConsensus`
- `AgentPoolV432TaskMarket`

Analysis environment:

```text
Slither: 0.11.6
solc: 0.8.36
optimizer: enabled
optimizer runs: 500
viaIR: true
dependencies: compiled, findings excluded
```

The machine-readable detector profile is pinned in
`audits/v44-slither-baseline.json`. `npm run security:slither:v4.4` reruns all
14 targets and fails if any high/medium detector type or count changes. A
decrease also requires review and an intentional baseline update; it is not
silently accepted.

Representative invocation from the repository root:

```powershell
slither contracts/v43/AgentPoolV432TaskMarket.sol `
  --solc C:\path\to\solc.exe `
  --solc-args "--base-path . --include-path node_modules --allow-paths . --optimize --optimize-runs 500 --via-ir" `
  --exclude-dependencies `
  --json task-market.json
```

The analyzed contract source tree is the one used by the v4.4 release evidence
pipeline. Reviewers must independently record `git rev-parse HEAD`,
`git rev-parse HEAD:contracts`, and the SHA-256 of
`outputs/v44-source-reproducibility.json` before beginning their review.

## Result summary

```text
High:   1 reported, 0 confirmed
Medium: 28 reported, 0 confirmed
```

No reported item was accepted as proof that the mainnet candidate is safe.
Each item below remains part of the external review checklist.

| Contract | High | Medium | Triage |
|---|---:|---:|---|
| `AgentPoolV44Token` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43SettlementRouter` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43ReleaseRegistry` | 0 | 1 | Intentional strict enum equality |
| `AgentPoolV43CapacityRegistry` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43UserEscrowKernel` | 1 | 0 | Restricted `transferFrom`, see below |
| `AgentPoolV43EpochVault` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43ContributionLedger` | 0 | 3 | Conservative flooring and zero defaults |
| `AgentPoolV432ProofRegistry` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43EvolutionConsensus` | 0 | 0 | No high or medium detector output |
| `AgentPoolV43HashObjectiveVerifier` | 0 | 0 | No high or medium detector output |
| `AgentPoolV435SystemIssueGate` | 0 | 0 | No high or medium detector output |
| `AgentPoolV435TransitionIssueConsensus` | 0 | 1 | Revert-on-invalid validation call |
| `AgentPoolV432IssueConsensus` | 0 | 0 | No high or medium detector output |
| `AgentPoolV432TaskMarket` | 0 | 23 | State ordering, zero defaults, strict equality |

## High finding: arbitrary ERC-20 transfer

Slither reports `AgentPoolV43UserEscrowKernel.lock` because it calls
`safeTransferFrom(buyer, address(this), amount)` and `buyer` is a parameter.
The transfer is not permissionless:

1. `lock` requires `msg.sender == market`.
2. `market` is configured once with a nonzero contract.
3. configuration authority is then permanently cleared.
4. the deployed market disables the legacy external-job entrypoint.
5. `createExternalJobV2` passes its own `msg.sender` as `buyer`.
6. the buyer must explicitly approve the exact escrow token first.
7. deposits are unique by `jobId` and cannot exceed the buyer-approved amount.

This is classified as a false positive under the exact deployment wiring, not
as a reason to waive external review. A reviewer should still try to find a
path that makes the configured market pass a victim address other than the
external job creator.

## Medium findings

### Reentrancy ordering

Slither flags external calls made after storage writes in TaskMarket. The
deployed entrypoints that move funds or reserve capacity use
`ReentrancyGuard`: job creation, acceptance, resolution, and expiry/refund.
Delivery and candidate/adoption attestations commit one-shot state before
calling one-time-configured protocol contracts. The configured contracts and
token addresses are provenance-checked by the deployment pipeline.

This is an architectural justification, not a blanket suppression. External
review must attempt recursive calls through:

- the APOOL token,
- user escrow,
- epoch vaults,
- capacity registry,
- proof registry,
- settlement router,
- objective verifier,
- release registry, and
- system issue gate.

The review must prove that recursion cannot duplicate a payment, capacity
release, candidate receipt, adoption receipt, or contribution record.

### Strict equality

Release usability uses exact enum states. This intentionally prevents unknown
or future enum values from being treated as usable. TaskMarket also uses exact
milestone counts, payout roots, and dependency masks to reject partially
matching plans.

### Divide before multiply

Contribution reliability floors the ratio before a later bounded
multiplication. The flooring is conservative: it can reduce Work Power but
cannot increase it. Reviewers must verify that no small denominator, epoch
rollover, or integer-width conversion can reverse that property.

### Uninitialized local values

The reported local accumulator values rely on Solidity's defined zero default.
They are not read as arbitrary memory. This was left explicit in the triage
instead of adding cosmetic initializers that would change bytecode without
changing behavior.

### Ignored boolean return

`TransitionIssueConsensus.propose` calls
`SystemIssueGate.validateTransitionIssue`. The callee reverts on invalid terms
and returns `true` otherwise, so the call is used for validation by revert.
Reviewers must confirm that no alternate configured gate can return `false`
without reverting. Deployment provenance must bind the exact gate bytecode.

## Required regression evidence

The repository must continue to prove all of the following:

- external escrow can only pull from the external job creator;
- old V4.3 job entrypoints revert in the V4.3.2 market;
- reentrant calls cannot duplicate settlement, refund, adoption, or capacity
  release;
- invalid deterministic proof cannot reject another worker's delivery;
- the evaluator cannot select payout recipients or amounts;
- candidate attestation binds module, manifest, delivery, and canary metrics;
- release adoption binds the release actually executed by the settled job;
- all mainnet deployment contracts fit below the 24,576-byte EVM limit;
- source, compiler settings, creation bytecode, and runtime bytecode are
  reproducible.

## Maintainer conclusion

No confirmed exploitable high or medium issue was found in this Slither pass.
The result reduces uncertainty but does not make a mainnet deployment safe by
itself. The independent review gate remains blocked until a reviewer who did
not author these contracts reproduces the build, inspects the trust boundaries,
and delivers signed findings for the exact source evidence.
