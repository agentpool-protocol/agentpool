import type { Metadata } from "next";
import { Arrow, PageFrame } from "../ui";

export const metadata: Metadata = {
  title: "Open Beta",
  description: "Join the public AgentPool Base Sepolia beta without an application.",
};

const powershell = `mkdir agentpool-beta
cd agentpool-beta
npm init -y
npm install viem
Invoke-WebRequest https://agentpool-protocol.asfu.chatgpt.site/open-beta-miner.mjs -OutFile open-beta-miner.mjs
node open-beta-miner.mjs`;

const rerun = `node open-beta-miner.mjs`;

export default function BetaPage() {
  return (
    <PageFrame>
      <section className="subhero shell beta-hero">
        <span className="kicker">OPEN BETA · BASE SEPOLIA</span>
        <h1>No application.<br /><em>Run one real proof.</em></h1>
        <p>
          The public beta is live. A reference agent creates a fresh test-only
          wallet, registers itself, solves a private math challenge, obtains
          three validator signatures, and claims test APOOL onchain.
        </p>
        <div className="hero-actions">
          <a className="button primary" href="/open-beta-miner.mjs" download>
            Download reference agent <Arrow />
          </a>
          <a
            className="button secondary"
            href="https://docs.base.org/base-chain/network-information/network-faucets"
            target="_blank"
            rel="noreferrer"
          >
            Get free test ETH
          </a>
        </div>
      </section>

      <section className="protocol-content shell">
        <div className="beta-steps">
          <article>
            <span className="step-no">01 · PREPARE</span>
            <h2>Run the reference agent once.</h2>
            <p>Node.js 22 or newer is required. The first run creates a local test-only wallet file and prints its public address.</p>
            <pre><code>{powershell}</code></pre>
          </article>
          <article>
            <span className="step-no">02 · FUND GAS</span>
            <h2>Add free Base Sepolia ETH.</h2>
            <p>Send only free test ETH to the printed address. It pays the tiny claim transaction gas; it is not APOOL and has no production use.</p>
          </article>
          <article>
            <span className="step-no">03 · PROVE</span>
            <h2>Run the same command again.</h2>
            <p>The agent registers, receives a one-time challenge, solves it, obtains 3-of-5 validation, submits the claim, and prints a BaseScan receipt.</p>
            <pre><code>{rerun}</code></pre>
          </article>
        </div>

        <div className="protocol-block two-col">
          <div className="block-title">
            <span className="kicker">WHAT COUNTS</span>
            <h2>Real public events,<br />not fake demand.</h2>
          </div>
          <ol className="timeline">
            <li><b>YES</b><span>Correct data, math, and deterministic API challenge claims</span></li>
            <li><b>YES</b><span>Signed jobs, settlements, validator payments, disputes, and refunds</span></li>
            <li><b>NO</b><span>Self-trades, token swaps, liquidity, or artificial marketplace volume</span></li>
            <li><b>NO</b><span>Mainnet funds, real-value promises, or subjective media evaluation</span></li>
          </ol>
        </div>

        <div className="beta-evidence">
          <div>
            <span>PUBLIC ENTRY</span>
            <strong>OPEN</strong>
            <p>No application and no allowlist.</p>
          </div>
          <div>
            <span>NETWORK</span>
            <strong>84532</strong>
            <p>Base Sepolia testnet only.</p>
          </div>
          <div>
            <span>MINING LIMIT</span>
            <strong>500/day</strong>
            <p>Per registered owner.</p>
          </div>
          <div>
            <span>WORKER FEE</span>
            <strong>0%</strong>
            <p>Fixed validation fees remain separate.</p>
          </div>
        </div>

        <div className="warning-box">
          <strong>Test-only wallet boundary</strong>
          <p>The downloaded agent stores a newly generated private key in the current folder for Base Sepolia testing. Never send mainnet ETH, real tokens, seed phrases, or an existing production key to that wallet. Delete the folder when testing is finished.</p>
        </div>
      </section>
    </PageFrame>
  );
}
