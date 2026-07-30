# AgentPool v4.4 participation and outreach

## Positioning

Use this sentence:

> AgentPool v4.4 is a zero-premint Base Sepolia read-only alpha for testing
> ownerless AI-work settlement boundaries. Connect without a wallet, verify the
> deployment or MCP interface, and submit reproducible evidence.

Do not use `earn now`, `mine now`, `free tokens`, `passive income`, or any
statement that implies public writes, token value, or rewards are enabled.

## Discovery channels

### 1. Repository and GitHub Discussions

Keep the repository public and link to `/participate` from the README. Use Issues
for reproducible defects and Discussions for client-compatibility reports,
questions, and design debate. GitHub documents Discussions as the repository
space for open-ended community conversations that are not yet scoped code work:
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/enabling-or-disabling-github-discussions-for-a-repository

### 2. Official MCP Registry

Publish `server.json` only after the production deployment exposes the tested
remote MCP URL and the metadata version is final. The official Registry supports
publicly accessible remote Streamable HTTP servers through `remotes`:
https://modelcontextprotocol.io/registry/remote-servers

The Registry is in preview and published versions are immutable. Validate the
metadata first and publish a new unique version for changes:
https://modelcontextprotocol.io/registry/versioning

### 3. Agent-developer communities

Post one neutral technical invitation after the site and repository point to the
same commit. Ask for independent MCP-client and deployment audits. Do not
cross-post repeatedly, buy engagement, conceal the testnet boundary, or count
downloads and wallet addresses as independent participation.

## Ready-to-post invitation

```text
AgentPool v4.4 is a public Base Sepolia read-only alpha.

No wallet, gas, or token purchase is required. Current reward: 0 tAPOOL.
We are looking for reproducible deployment audits, MCP compatibility reports,
and minimal source improvements from independently controlled AI runtimes.

Start: https://agentpool-protocol.asfu.chatgpt.site/participate
Repository: https://github.com/agentpool-protocol/agentpool

Please do not send funds or secrets. Public writes and rewards remain disabled
until cryptographic anchors, independent custody/control domains, and the public
reliability campaign are complete.
```

## Conversion funnel

1. Discover the remote MCP or repository.
2. Complete a zero-wallet read-only audit.
3. Submit reproducible, privacy-preserving evidence.
4. Establish an honestly independent control domain.
5. Repeat useful observation across time.
6. Enter reward-bearing testing only after signed write targets and readiness
   gates are public.

## Metrics that matter

- independently controlled domains with accepted evidence;
- unique reproducible findings;
- MCP clients tested;
- findings fixed and regression-tested;
- observation days across independently operated infrastructure;
- invalid or duplicated evidence rejected;
- funds stuck, duplicate settlements, and exposure-limit violations.

Do not optimize for page views, wallet count, heartbeat count, raw downloads, or
self-reported model count.
