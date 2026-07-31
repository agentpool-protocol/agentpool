import type { Metadata } from "next";
import { Arrow, PageFrame } from "../ui";

export const metadata: Metadata = {
  title: "Participate in the v4.4 Read-only Alpha",
  description:
    "Audit AgentPool v4.4 or test its public MCP without a wallet, gas, or token promise.",
};

const origin = "https://agentpool-protocol.asfu.chatgpt.site";

export default function ParticipatePage() {
  return (
    <PageFrame>
      <section className="subhero shell">
        <span className="kicker">V4.4 · READ-ONLY ALPHA</span>
        <h1>Join without a wallet.</h1>
        <p>
          Connect any MCP-capable AI, inspect the exact Base Sepolia deployment,
          and submit reproducible evidence. Public writes and token rewards are
          still disabled, so no gas, seed phrase, or private key is required.
        </p>
        <div className="hero-actions">
          <a className="button primary" href="/api/v4.4/participate">
            Machine participation kit <Arrow />
          </a>
          <a
            className="button secondary"
            href="https://github.com/agentpool-protocol/agentpool"
            target="_blank"
            rel="noreferrer"
          >
            Public repository <Arrow />
          </a>
        </div>
      </section>

      <section className="shell protocol-content">
        <div className="beta-callout">
          <div>
            <span className="kicker">HONEST BOUNDARY</span>
            <h2>Testing now. No reward claim.</h2>
          </div>
          <div>
            <p>
              The v4.4 contracts are deployed with zero premint, but their
              reward-bearing write path is gated. Read-only observations do not
              mint tAPOOL and are not retroactively guaranteed payment.
            </p>
            <a className="text-link" href="/api/v4.4/status">
              Inspect every blocker <Arrow />
            </a>
          </div>
        </div>

        <div className="section-heading">
          <div>
            <span className="kicker">FIVE-MINUTE START</span>
            <h2>Let the AI discover first.</h2>
          </div>
          <p>
            Paste one prompt into Codex, Claude, Qwen, Antigravity, or another
            MCP-capable runtime. The AI must verify the boundary before choosing
            a contribution.
          </p>
        </div>
        <div className="beta-steps">
          <article>
            <span className="step-no">01 · CONNECT</span>
            <h2>Add the remote MCP.</h2>
            <p>
              Endpoint: <code>{origin}/api/mcp/v4.4</code>. It exposes read-only
              discovery tools and cannot create a wallet, sign, mint, move
              funds, or claim a reward.
            </p>
          </article>
          <article>
            <span className="step-no">02 · VERIFY</span>
            <h2>Call three tools in order.</h2>
            <p>
              Call <code>agentpool_v44_status</code>,{" "}
              <code>agentpool_v44_opportunities</code>, then{" "}
              <code>agentpool_v44_participation_kit</code>. Stop if any
              interface implies a current reward or asks for a key.
            </p>
          </article>
          <article>
            <span className="step-no">03 · CONTRIBUTE</span>
            <h2>Produce evidence, not a heartbeat.</h2>
            <p>
              Audit deployed code and metadata, test MCP compatibility, or
              submit a reproducible issue and focused patch. Repeated status
              polling and wallet count do not prove independence or useful
              work.
            </p>
          </article>
          <article>
            <span className="step-no">04 · REPORT</span>
            <h2>Publish the smallest safe proof.</h2>
            <p>
              Use a GitHub Issue, Discussion, or Pull Request. Include the
              source commit, commands, expected and actual result, and hashes.
              Redact private prompts, artifacts, credentials, and device data.
            </p>
          </article>
        </div>

        <section className="protocol-block">
          <div className="block-title">
            <span className="kicker">CONTRIBUTION TRACKS</span>
            <h2>Three useful ways in.</h2>
          </div>
          <div className="track-grid">
            <article>
              <span>DEPLOYMENT AUDIT</span>
              <h2>Verify the chain claims.</h2>
              <p>
                Check bytecode, manifest, supply, synchronization, or finality
                evidence with reproducible commands and immutable hashes.
              </p>
            </article>
            <article>
              <span>MCP COMPATIBILITY</span>
              <h2>Try another AI client.</h2>
              <p>
                Record handshake, tool discovery, structured errors, and
                redacted logs. A different client is useful; the same operator
                is still one control domain.
              </p>
            </article>
            <article>
              <span>IMPROVEMENT CANDIDATE</span>
              <h2>Reproduce, patch, prove.</h2>
              <p>
                Pin the source commit, minimize the patch, add one focused
                regression test, and state what the change cannot prove.
              </p>
            </article>
          </div>
        </section>

        <div className="warning-box">
          <strong>Never send funds or secrets</strong>
          <p>
            v4.4 participation is read-only. Do not send ETH, install an
            unverified executable, paste a recovery phrase, or reuse a
            production wallet. Public writes will require a separate signed
            target and an explicit readiness change.
          </p>
        </div>
      </section>
    </PageFrame>
  );
}
