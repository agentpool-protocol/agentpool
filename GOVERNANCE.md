# AgentPool governance and authority

AgentPool separates source hosting, protocol authority, and infrastructure
operation.

## What GitHub controls

The `agentpool-protocol/agentpool` repository is a public collaboration and
distribution mirror. Its maintainers can review pull requests, publish source
archives, and operate repository automation. They cannot use GitHub access to:

- change an already-created onchain assignment;
- change a release hash pinned by an assignment;
- mint beyond an immutable emission controller;
- withdraw user escrow;
- rewrite an append-only onchain release record; or
- convert an unproven module into an accepted settlement proof.

Repository tags and the default branch are convenient discovery signals, not
financial authority.

## Canonical release identity

Every protocol release is identified by content, not by a GitHub account:

```text
releaseId =
keccak256(
  source archive hash
  + contract bytecode hashes
  + module manifest hash
  + policy hash
  + verification evidence hash
)
```

The relevant Base deployment and `ReleaseRegistry` event are authoritative
once v4.1 is deployed. Before that deployment, all v4.1 releases must be
described as local rehearsal or public alpha software, never as live onchain
settlement.

Anyone may mirror the source and reproduce a release. A mirror is valid when
its content hashes match the registered release; the domain or account hosting
it does not confer special authority.

## Change process

1. Open an issue containing a reproducible problem or a bounded proposal.
2. Submit a pull request with tests and deterministic build instructions.
3. Run static, adversarial, and economic-invariant checks.
4. Register the candidate as a new module or release; never overwrite an
   existing release.
5. Test the candidate in shadow and isolated canary environments.
6. Mark it proven only after its precommitted evidence policy passes.
7. New assignments may select it; existing assignments remain pinned to their
   original release and policy.

No pull request by itself changes live settlement rules.

## Maintainer transition

The organization begins with one setup operator because GitHub requires an
account owner. Public organization membership may be private, but this must
not be described as a literally ownerless GitHub repository.

The intended transition is:

1. add at least two independent maintainers;
2. require protected-branch pull requests and independent review;
3. use narrowly scoped automation for reproducible releases;
4. keep deployer, validator, treasury, and GitHub credentials separate; and
5. retain multiple public mirrors so loss of one organization cannot remove
   the source.

The ownerless property belongs to the immutable financial kernel, not to a
hosting account.
