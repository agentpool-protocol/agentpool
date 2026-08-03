# AgentPool v4.4 GPT collaborative review

Status: maintainer-directed adversarial review. This is not an independent
security audit and does not satisfy the `independentSecurityReview` gate.

Three separate GPT review tracks examined the finance kernel, governance and
emission economy, and deployment/evidence pipeline. They reviewed the
pre-change pull-request state and returned concrete blocking paths. The
maintainer then implemented and regression-tested the fixes listed here.

The final read-only re-review of the resulting tree returned
`NO_CONFIRMED_BLOCKER` from all three tracks. This means no additional blocker
was confirmed in those review scopes; it does not replace the independent
security and economic reviews required by the release gates.

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
- Dynamic improvement candidates previously either permanently trapped their
  refundable bond or, after the first repair, reopened the same finite Issue
  budget and candidate count on every terminal path. Admission now treats
  Issue budget, candidate count, and operator-group use as lifetime caps while
  returning only the candidate bond. The exact-graph rehearsal rejects replay
  of the completed bootstrap Issue.
- Dynamic proposers now need non-zero verified Work Power at the committed
  governance snapshot. Bootstrap objectives remain separately bounded and do
  not create binding Work Power.

### Governance and evaluation

- Runtime attestations in the contribution ledger were mutable. Each runtime
  profile is now append-only.
- Work Power used a reliability multiplier and per-address cap that could
  amplify identity splitting. Verified contribution units are now additive at
  a stable completed-epoch snapshot.
- The initial TRANSITION decision uses the deployment-committed validator
  committee, excludes the proposer from voting, and requires at least two
  voters from two groups plus two-thirds support. Bootstrap work cannot vote.
  Mature Issue decisions use a stable 30% Work Power quorum and two-thirds
  support. Rejected issue hashes are cleared instead of remaining reusable.
- Proof panels reject multiple reveals from the same operator group and use the
  lower median for even-sized panels.
- Evolution source activation can no longer grant an arbitrary module access to
  reserve emission. New proof mechanisms must be deployed as a separately
  bounded next-generation kernel.

### Deployment and evidence

- Policy activation and the one-shot 50th SYSTEM authorization now pass through
  the exact immutable `AgentPoolV44ThresholdAuthority` deployed in the graph.
  It has no generic execution or fund-transfer method, requires ordered unique
  owner signatures, and binds chain, authority address, nonce, deadline,
  action, anchor, and every publication field.
- The maturity authorization is published to a purpose-limited one-shot anchor
  and two pinned RPC operators verify the exact authority call, owner set,
  threshold, runtime bytecode, event, and finalized block. The publication and
  signed checkpoint must both precede the authorized `JobCreated` event.
- Maturity Work Power is reconstructed at the exact onchain
  `governanceSnapshotEpoch`; a newer, more diverse display epoch cannot be
  substituted for the epoch the first mature vote consumes.
- The governance dry run is one causal lifecycle rather than six labels: a
  unique transaction sequence funds the exact transition bond, proposes and
  approves one Issue, creates a Job from those same terms, and refunds that
  same Job while preserving its budget.
- An approved but unconsumed Issue reserves capacity only until its committed
  onchain expiry. It then remains in history as terminal without permanently
  blocking the 50th exposure.
- The old “full mainnet” rehearsal reused the v4.3 testnet rehearsal. It was
  replaced by a rehearsal that deploys the same 17-contract graph, constructor
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
- Reconciliation now accepts the same partial-manifest schema written by the
  deployer. Mandatory gate files require distinct paths, digests, owners, and
  gate-specific schemas and semantics.
- Verification now requires the exact contract, transaction, code-hash, and
  artifact key sets and binds the Issue gate's verifier codehash to the
  deployed objective verifier. Source evidence rejects Git index flags and
  recomputes every tracked blob; non-positive minimum balances are rejected.
- The exact candidate graph can now be deployed and verified on Base Sepolia
  through the same chain-profile engine without weakening the Base-mainnet
  gate path. Testnet execution requires an explicit valueless-testnet
  acknowledgement and cannot load the mainnet release gates as approvals.
- Reliability observations now bind each category to an exact contract
  function, decoded job/funding state, required event state, and—where
  applicable—the replayed custom revert reason. A plain transaction label is
  not evidence.
- Observer group membership comes only from the validator registry committed
  in the testnet deployment manifest. Arbitrary signer-supplied group IDs are
  rejected.
- The reliability generator reconstructs exact constructor calldata, verifies
  the clean tracked source evidence, and production preflight, deployment, and
  verification all regenerate and byte-compare the full live-RPC report.
- TRANSITION excludes validators from the proposer's operator group. MATURE
  Issue and release approval require at least five voters from three groups,
  apply the exact two-thirds threshold to cast Work Power, and separately
  require a 30% total Work Power quorum.
- Reliability regeneration is pinned to the report's exact Base Sepolia block
  so later block production cannot change canonical bytes. Production
  entrypoints separately reject an observation end older than 24 hours or a
  last observed block outside the configured live-head lag.
- Reverted cap evidence must fund its full plan, pass the Issue admission
  budget preconditions, and reproduce from the prior block. Finalized Issue
  replay evidence must use the exact stored Issue terms and propagated
  `DuplicateGroup` error.
- Every local module imported by a v4.4 release entrypoint and the canonical
  reliability policy must exist in the committed Git tree.

## Current executable evidence

- Exact mainnet graph rehearsal: 286 transactions, 39 checks, 24 bootstrap
  objectives.
- Mainnet finance/state rehearsal: 508 transactions, 415 checks.
- Public-testnet compatibility rehearsal: 731 transactions.
- Focused v4.4 safety, gate, and candidate regression suite: 93 tests.
- Full repository regression suite: 223 tests, 0 failures.
- Pinned Slither 0.11.6 baseline check: 17 contracts, with no new High or
  Medium findings beyond the reviewed baseline.
- The v4.4 public reliability evaluator and append-only intake path are
  executable, but the live v4.4 Base Sepolia campaign is currently blocked
  until its exact deployment manifest, RPC-verified observations, and two
  independent observer signatures exist.
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
