# AgentPool v4.4 GPT collaborative review

Status: maintainer-directed adversarial review. This is not an independent
security audit and does not satisfy the `independentSecurityReview` gate.

Three separate GPT review tracks examined the finance kernel, governance and
emission economy, and deployment/evidence pipeline. They reviewed the
pre-change pull-request state and returned concrete blocking paths. The
maintainer then implemented and regression-tested the fixes listed here.

## Closed findings

### Finance and liveness

- A worker that was not registered could previously accept a task and later
  reach an unrecoverable settlement path. Acceptance now requires a registered
  worker and runtime profile.
- Validator non-participation could previously reach the worker-failure slash
  path. Proof resolution now distinguishes `NO_QUORUM`, `FAIL`, and `PASS`.
  `NO_QUORUM` refunds the buyer and returns the honest worker bond.
- A delivered task could outlive the proof reveal window. Delivery now extends
  the settlement deadline through the committed proof policy.
- A mutable same-job replan could weaken unfinished work. Replanning now
  requires a separately admitted continuation job; the original policy,
  objective, deadline, and payout remain pinned.

### Emission and candidate admission

- Epoch reservations could be stacked before settlement and then consumed in
  a later epoch. Reservation and settlement now account against the actual
  epoch and include already-reserved emission in the cap check.
- Dynamic improvement candidates could permanently consume candidate slots and
  issue budget. Admission now locks a 10 APOOL refundable bond, and every
  terminal task path releases the slot, committed budget, group lock, and bond.
- Dynamic proposers now need non-zero verified Work Power at the committed
  governance snapshot. Bootstrap objectives remain separately bounded and do
  not use this path.

### Governance and evaluation

- Runtime attestations in the contribution ledger were mutable. Each runtime
  profile is now append-only.
- Work Power used a reliability multiplier and per-address cap that could
  amplify identity splitting. Verified contribution units are now additive at
  a stable completed-epoch snapshot.
- Issue and transition decisions now require both 30% Work Power quorum and
  two-thirds support. Rejected issue hashes are cleared instead of remaining
  reusable.
- Proof panels reject multiple reveals from the same operator group and use the
  lower median for even-sized panels.
- Evolution source activation can no longer grant an arbitrary module access to
  reserve emission. New proof mechanisms must be deployed as a separately
  bounded next-generation kernel.

### Deployment and evidence

- The old “full mainnet” rehearsal reused the v4.3 testnet rehearsal. It was
  replaced by a rehearsal that deploys the same 15-contract graph, constructor
  arguments, one-time wiring, authority removal, and 24-objective bootstrap
  catalog used by the v4.4 mainnet deployment script.
- Release gates now require exactly seven canonical records. Every approval
  binds the SHA-256 of an actual non-empty evidence file and an independently
  supplied digest.
- Source evidence binds the exact commit, contract tree, compiler settings,
  artifacts, configuration, creation bytecode, runtime bytecode, and bootstrap
  identity. Changed evidence fields or a dirty tracked worktree fail closed.
- Interrupted deployment journals bind the chain, deployer, nonce, source,
  configuration, bootstrap catalog, gate evidence, and release identity before
  broadcast. Unknown broadcasts require explicit read-only reconciliation.

## Current executable evidence

- Exact mainnet graph rehearsal: 263 transactions, 26 checks, 24 bootstrap
  objectives.
- Mainnet finance/state rehearsal: 508 transactions, 415 checks.
- Public-testnet compatibility rehearsal: 385 transactions.
- The exact graph additionally proves that an unregistered worker cannot accept
  a task, an external buyer job mints no APOOL, and validator no-quorum refunds
  the buyer without slashing the honest worker.

These counts are reproducible local evidence, not observations of independent
mainnet operators.

## Gates that remain external

The following cannot be satisfied by the project author running more local
tests:

- an independent security review of the exact final source and bytecode;
- a public reliability record with independent participants;
- evidence that bootstrap validator keys belong to distinct operational
  groups;
- an independent economic-invariant review;
- the actual deployer's legal assessment for its own conduct and jurisdiction;
- AgentPool/APOOL name and symbol clearance.

The deployment script must remain blocked until every required evidence file is
present and its digest matches. A GPT finding being closed does not authorize a
mainnet transaction.
